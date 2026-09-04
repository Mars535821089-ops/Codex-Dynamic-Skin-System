import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const MANIFEST_SCHEMA = "codex-dynamic-skin-runtime/1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]*\.js$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(`Dynamic runtime bundle rejected: ${message}`);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    fail(`${label} fields are invalid`);
  }
}

async function readRegularFile(filePath, maxBytes, label) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) {
    fail(`${label} must be a bounded regular file`);
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) {
      fail(`${label} changed while it was being opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || bytes.length !== opened.size) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function loadVersionedDynamicModuleBundle(engineRoot) {
  const assetsRoot = path.resolve(engineRoot, "assets");
  const realAssetsRoot = await fs.realpath(assetsRoot);
  if ((await fs.lstat(assetsRoot)).isSymbolicLink()) fail("assets root must not be a symbolic link");
  const manifestPath = path.join(assetsRoot, "dynamic-runtime-manifest.json");
  if (await fs.realpath(manifestPath) !== path.join(realAssetsRoot, "dynamic-runtime-manifest.json")) {
    fail("manifest must not traverse a symbolic link");
  }
  const manifestBytes = await readRegularFile(manifestPath, MAX_MANIFEST_BYTES, "manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  exactKeys(manifest, ["schema", "modules"], "manifest");
  if (manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.modules)
    || manifest.modules.length < 2) {
    fail("manifest schema or module list is invalid");
  }
  const names = manifest.modules.map((entry) => entry?.name);
  if (names[0] !== "module-registry.js" || names.at(-1) !== "entry.js"
    || new Set(names).size !== names.length
    || names.some((name) => typeof name !== "string" || !MODULE_NAME_PATTERN.test(name))) {
    fail("module order is invalid");
  }

  let totalBytes = 0;
  const modules = [];
  for (let index = 0; index < manifest.modules.length; index += 1) {
    const entry = manifest.modules[index];
    exactKeys(entry, ["name", "path", "sha256"], `modules[${index}]`);
    if (entry.path !== `dynamic/browser/${entry.name}` || !SHA256_PATTERN.test(entry.sha256)) {
      fail(`modules[${index}] path or digest is invalid`);
    }
    const modulePath = path.resolve(assetsRoot, entry.path);
    if (!modulePath.startsWith(`${assetsRoot}${path.sep}`)) fail("module path escapes the assets root");
    const realModulePath = await fs.realpath(modulePath);
    if (realModulePath !== path.resolve(realAssetsRoot, entry.path)) {
      fail(`module ${entry.name} must not traverse a symbolic link`);
    }
    const bytes = await readRegularFile(modulePath, MAX_MODULE_BYTES, `module ${entry.name}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUNDLE_BYTES) fail("module bundle exceeds its size limit");
    const source = bytes.toString("utf8");
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    if (digest !== entry.sha256) fail(`module ${entry.name} does not match its SHA-256 digest`);
    modules.push(Object.freeze({ name: entry.name, sha256: entry.sha256, source }));
  }
  return Object.freeze(modules);
}
