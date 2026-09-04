#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsRoot, "..");
const checkOnly = process.argv.slice(2).includes("--check");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);

const DYNAMIC_BROWSER_MODULES = Object.freeze([
  "module-registry.js",
  "media-layer.js",
  "audio-bus.js",
  "performance-policy.js",
  "signal-model.js",
  "voxel-field.js",
  "semantic-events.js",
  "controls.js",
  "controller.js",
  "entry.js",
]);
const DYNAMIC_NODE_ASSETS = Object.freeze([
  "theme-contract.mjs",
  "theme-contract.json",
  "content-manifest.mjs",
  "theme-loader.mjs",
  "settings.mjs",
  "payload-composer.mjs",
  "module-bundle-loader.mjs",
  "media-signatures.mjs",
  "zip-preflight.mjs",
  "asset-host.mjs",
]);

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const selectorSource = await fs.readFile(path.join(toolsRoot, "selectors.json"), "utf8");
const contract = JSON.parse(selectorSource);
if (contract.schema !== "codex-dream-skin-selectors/1" || !Array.isArray(contract.selectors)) {
  throw new Error("tools/selectors.json has an unsupported schema");
}
const selectors = new Map();
for (const entry of contract.selectors) {
  if (!entry?.key || !entry?.selector || selectors.has(entry.key)) {
    throw new Error(`Invalid or duplicate selector key: ${entry?.key || "<missing>"}`);
  }
  selectors.set(entry.key, entry.selector);
}

function compileSelectorTokens(source, sourceName) {
  const compiled = source.replace(/__DREAM_SELECTOR_([A-Z0-9_]+)__/g, (token, identifier) => {
    const key = identifier.toLowerCase().replaceAll("_", "-");
    const selector = selectors.get(key);
    if (!selector) throw new Error(`${sourceName} references unknown selector token ${token}`);
    return selector;
  });
  const unresolved = compiled.match(/__DREAM_SELECTOR_[A-Za-z0-9_]+__/);
  if (unresolved) throw new Error(`${sourceName} contains unresolved selector token ${unresolved[0]}`);
  return compiled;
}

function compileRuntime(source) {
  const token = "__DREAM_SKIN_SELECTORS_JSON__";
  const occurrences = source.split(token).length - 1;
  if (occurrences !== 1) {
    throw new Error(`runtime/renderer-inject.js must contain exactly one ${token} token`);
  }
  // The renderer needs only executable selector data. Keep the full
  // contract (including verification provenance and retired probes) in the
  // staged selectors.json, but do not ship documentation/fossil strings in
  // every page payload. This projection is still generated exclusively from
  // tools/selectors.json, so there is no second editable selector source.
  const runtimeContract = {
    schema: contract.schema,
    selectors: contract.selectors.map(({ key, selector, tier, scope, required }) => ({
      key, selector, tier, scope, required: Boolean(required),
    })),
    stableTestids: Array.isArray(contract.stableTestids) ? [...contract.stableTestids] : [],
  };
  return source.replace(token, JSON.stringify(runtimeContract));
}

function compileSafeCssFileValidator(source) {
  const canonicalImport = 'from "./safe-css-validator.mjs"';
  const occurrences = source.split(canonicalImport).length - 1;
  if (occurrences !== 1) {
    throw new Error("runtime/validate-safe-css-file.mjs must import the canonical Safe CSS validator once");
  }
  return source.replace(canonicalImport, 'from "../assets/safe-css-validator.mjs"');
}

// Both injectors enforce the 16384px / 50MP decode limits through this parser,
// so the two platform copies must not drift. Windows additionally needs a tiny
// CLI so theme-windows.ps1 can shell out to it; that entry point is appended
// here instead of being maintained as a second hand-edited copy of the parser.
const WINDOWS_IMAGE_METADATA_CLI = `
// Keep the PowerShell theme store on the same strict parser as the injector.
// The CLI is intentionally tiny: it only reads a user-selected file and emits
// validated dimensions; it never writes or follows a caller-provided output.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, imagePath] = process.argv.slice(2);
  if (mode !== "--check" || !imagePath) {
    console.error("Usage: image-metadata.mjs --check <image>");
    process.exitCode = 2;
  } else {
    try {
      const resolved = path.resolve(imagePath);
      const bytes = await fs.readFile(resolved);
      const metadata = readImageMetadata(bytes, path.extname(resolved));
      if (!metadata) throw new Error("Image metadata is invalid or exceeds the 16384px / 50MP safety limit");
      console.log(JSON.stringify(metadata));
    } catch (error) {
      console.error(error?.message ?? String(error));
      process.exitCode = 2;
    }
  }
}
`;

function compileWindowsImageMetadata(source) {
  if (source.includes("process.argv")) {
    throw new Error("runtime/image-metadata.mjs must stay a pure parser; the CLI is appended at sync time");
  }
  const imports = [
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "",
  ].join("\n");
  return `${imports}${source.trimEnd()}\n${WINDOWS_IMAGE_METADATA_CLI}`;
}

const sourceCss = await fs.readFile(path.join(projectRoot, "runtime", "dream-skin.css"), "utf8");
const sourceRuntime = await fs.readFile(path.join(projectRoot, "runtime", "renderer-inject.js"), "utf8");
const sourceThemePackageValidator = await fs.readFile(
  path.join(projectRoot, "runtime", "theme-package-validator.mjs"),
  "utf8",
);
const sourceSafeCssValidator = await fs.readFile(
  path.join(projectRoot, "runtime", "safe-css-validator.mjs"),
  "utf8",
);
const sourceSafeCssPolicy = await fs.readFile(
  path.join(projectRoot, "runtime", "safe-css-policy.json"),
  "utf8",
);
const sourceSafeCssFileValidator = await fs.readFile(
  path.join(projectRoot, "runtime", "validate-safe-css-file.mjs"),
  "utf8",
);
const sourceImageMetadata = await fs.readFile(
  path.join(projectRoot, "runtime", "image-metadata.mjs"),
  "utf8",
);
const dynamicBrowserRoot = path.join(projectRoot, "runtime", "dynamic", "browser");
const browserFiles = (await fs.readdir(dynamicBrowserRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const expectedBrowserFiles = [...DYNAMIC_BROWSER_MODULES].sort();
if (JSON.stringify(browserFiles) !== JSON.stringify(expectedBrowserFiles)) {
  throw new Error(
    `Dynamic browser module set must be exactly: ${DYNAMIC_BROWSER_MODULES.join(", ")}`,
  );
}
const dynamicBrowserSources = new Map(await Promise.all(
  DYNAMIC_BROWSER_MODULES.map(async (name) => [
    name,
    await fs.readFile(path.join(dynamicBrowserRoot, name), "utf8"),
  ]),
));
const dynamicNodeSources = new Map(await Promise.all(
  DYNAMIC_NODE_ASSETS.map(async (name) => [
    name,
    await fs.readFile(path.join(projectRoot, "runtime", "dynamic", name), "utf8"),
  ]),
));
const dynamicRuntimeManifest = `${JSON.stringify({
  schema: "codex-dynamic-skin-runtime/1",
  modules: DYNAMIC_BROWSER_MODULES.map((name) => ({
    name,
    path: `dynamic/browser/${name}`,
    sha256: sha256(dynamicBrowserSources.get(name)),
  })),
}, null, 2)}\n`;
const outputs = [
  {
    // The injector runs from a packaged platform tree, so stage the same
    // contract beside the renderer assets while keeping tools/selectors.json
    // as the only editable source.
    content: selectorSource,
    paths: ["macos/assets/selectors.json", "windows/assets/selectors.json"],
  },
  {
    content: compileSelectorTokens(sourceCss, "runtime/dream-skin.css"),
    paths: ["macos/assets/dream-skin.css", "windows/assets/dream-skin.css"],
  },
  {
    content: compileRuntime(sourceRuntime),
    paths: ["macos/assets/renderer-inject.js", "windows/assets/renderer-inject.js"],
  },
  {
    content: sourceThemePackageValidator,
    paths: [
      "macos/assets/theme-package-validator.mjs",
      "windows/assets/theme-package-validator.mjs",
    ],
  },
  {
    content: sourceSafeCssValidator,
    paths: [
      "macos/assets/safe-css-validator.mjs",
      "windows/assets/safe-css-validator.mjs",
    ],
  },
  {
    content: sourceSafeCssPolicy,
    paths: [
      "macos/assets/safe-css-policy.json",
      "windows/assets/safe-css-policy.json",
    ],
  },
  {
    content: compileSafeCssFileValidator(sourceSafeCssFileValidator),
    paths: [
      "macos/scripts/validate-safe-css-file.mjs",
      "windows/scripts/validate-safe-css-file.mjs",
    ],
  },
  {
    content: sourceImageMetadata,
    paths: ["macos/scripts/image-metadata.mjs"],
  },
  {
    content: sourceImageMetadata,
    paths: ["macos/assets/image-metadata.mjs", "windows/assets/image-metadata.mjs"],
  },
  {
    content: compileWindowsImageMetadata(sourceImageMetadata),
    paths: ["windows/scripts/image-metadata.mjs"],
  },
  ...DYNAMIC_NODE_ASSETS.map((name) => ({
    content: dynamicNodeSources.get(name),
    paths: [
      `macos/assets/dynamic/${name}`,
      `windows/assets/dynamic/${name}`,
    ],
  })),
  ...DYNAMIC_BROWSER_MODULES.map((name) => ({
    content: dynamicBrowserSources.get(name),
    paths: [
      `macos/assets/dynamic/browser/${name}`,
      `windows/assets/dynamic/browser/${name}`,
    ],
  })),
  {
    content: dynamicRuntimeManifest,
    paths: [
      "macos/assets/dynamic-runtime-manifest.json",
      "windows/assets/dynamic-runtime-manifest.json",
    ],
  },
];

async function writeFileAtomically(outputPath, content) {
  const directory = path.dirname(outputPath);
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle = null;
  await fs.mkdir(directory, { recursive: true });
  try {
    handle = await fs.open(temporaryPath, "wx", 0o666);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

let mismatches = 0;
for (const output of outputs) {
  for (const relativePath of output.paths) {
    const outputPath = path.join(projectRoot, relativePath);
    if (checkOnly) {
      const current = await fs.readFile(outputPath, "utf8").catch(() => null);
      if (current !== output.content) {
        console.error(`out-of-date=${relativePath}`);
        mismatches += 1;
      }
    } else {
      await writeFileAtomically(outputPath, output.content);
      console.log(`updated=${relativePath}`);
    }
  }
}

if (mismatches) process.exitCode = 1;
