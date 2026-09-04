import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const loaderUrl = new URL("../../runtime/dynamic/theme-loader.mjs", import.meta.url);
const packageValidatorUrl = new URL("../../runtime/theme-package-validator.mjs", import.meta.url);
const fixtureRoot = fileURLToPath(new URL("fixtures/themes", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const { buildContentManifest, writeContentManifest } = await import(
  new URL("../../runtime/dynamic/content-manifest.mjs", import.meta.url)
);

let loaderModule = null;
try {
  loaderModule = await import(loaderUrl);
} catch {
  // The first TDD run intentionally reaches requireLoader before implementation exists.
}

function requireLoader() {
  assert.ok(loaderModule, "installed skin loader module must exist");
  return loaderModule;
}

function fixture(name) {
  return path.join(fixtureRoot, name);
}

async function temporaryTheme(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-skin-loader-"));
  const themeDir = path.join(root, name);
  await fs.cp(fixture(name), themeDir, { recursive: true });
  return { root, themeDir };
}

async function shippedV1Theme(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-skin-shipped-v1-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.copyFile(path.join(projectRoot, "macos/assets/theme.json"), path.join(root, "theme.json")),
    fs.copyFile(path.join(projectRoot, "macos/assets/portal-hero.png"), path.join(root, "portal-hero.png")),
    fs.copyFile(path.join(fixture("v1-static"), "theme.css"), path.join(root, "theme.css")),
  ]);
  return root;
}

test("adapts the shipped v1 image theme without inventing dynamic audio", async (t) => {
  const { loadInstalledSkin } = requireLoader();
  const skin = await loadInstalledSkin(await shippedV1Theme(t), {
    platform: "macos",
    clientVersion: "2.0.0",
  });

  assert.equal(skin.sourceApiVersion, 1);
  assert.deepEqual(skin.theme.visual, {
    kind: "image",
    asset: "portal-hero.png",
    fit: "cover",
    opacity: 1,
  });
  assert.deepEqual(skin.theme.audio, {
    ambient: { source: "none", loop: true, volume: 0.7, analyze: false },
    ui: { volume: 0.8, events: {} },
  });
  assert.equal(skin.theme.styles, "theme.css");
  assert.equal(skin.legacyTheme.name, "Dynamic Skin Demo");
  assert.equal(skin.legacyTheme.image, "portal-hero.png");
});

test("keeps validated Safe CSS as text and sorts declared package files", async () => {
  const { loadInstalledSkin } = requireLoader();
  const skin = await loadInstalledSkin(fixture("v1-static"), {
    platform: "windows",
    clientVersion: "2.0.0",
  });

  assert.match(skin.safeCss, /data-ds-part="composer"/);
  assert.equal(typeof skin.safeCss, "string");
  assert.deepEqual(skin.declaredFiles, ["background.webp", "theme.css", "theme.json"]);
});

test("loads v2 through the canonical semantic contract", async (t) => {
  const { loadInstalledSkin } = requireLoader();
  const { root, themeDir } = await temporaryTheme("v2-video");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const asset of [
    "audio/ui/approval.wav",
    "audio/ui/completed.wav",
    "audio/ui/error.wav",
    "media/loop.mp4",
    "media/poster.webp",
  ]) {
    const target = path.join(themeDir, asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${asset}\n`);
  }
  await fs.mkdir(path.join(themeDir, "styles"), { recursive: true });
  await fs.writeFile(
    path.join(themeDir, "styles/theme.css"),
    '[data-ds-part="composer"] { border-color: var(--ds-theme-color-line); }\n',
  );

  const skin = await loadInstalledSkin(themeDir, {
    platform: "macos",
    clientVersion: "2.0.0",
  });

  assert.equal(skin.sourceApiVersion, 2);
  assert.equal(skin.theme.visual.kind, "video");
  assert.equal(skin.theme.audio.ambient.source, "visual");
  assert.equal(skin.legacyTheme, undefined);
  assert.deepEqual(skin.declaredFiles, [
    "audio/ui/approval.wav",
    "audio/ui/completed.wav",
    "audio/ui/error.wav",
    "media/loop.mp4",
    "media/poster.webp",
    "styles/theme.css",
    "theme.json",
  ]);
});

test("accepts and verifies a persisted content manifest without treating it as a theme asset", async (t) => {
  const { loadInstalledSkin } = requireLoader();
  const { root, themeDir } = await temporaryTheme("v1-static");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = await buildContentManifest(themeDir, ["background.webp", "theme.css", "theme.json"]);
  await writeContentManifest(path.join(themeDir, "content-manifest.json"), manifest);

  const skin = await loadInstalledSkin(themeDir, { platform: "macos", clientVersion: "2.0.0" });
  assert.equal(skin.contentManifest.versionId, manifest.versionId);
  assert.deepEqual(skin.declaredFiles, ["background.webp", "theme.css", "theme.json"]);

  await fs.appendFile(path.join(themeDir, "background.webp"), "drift");
  await assert.rejects(
    () => loadInstalledSkin(themeDir, { platform: "macos", clientVersion: "2.0.0" }),
    /content manifest|identity/i,
  );
});

test("rejects a package file changed while the installed skin is being read", async (t) => {
  const { loadInstalledSkin } = requireLoader();
  const { root, themeDir } = await temporaryTheme("v1-static");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(themeDir, "background.webp");
  await fs.truncate(imagePath, 15 * 1024 * 1024);
  const handle = await fs.open(imagePath, "r+");
  t.after(() => handle.close());
  let writes = 0;
  const timer = setInterval(() => {
    const byte = Buffer.from([writes % 251]);
    writes += 1;
    void handle.write(byte, 0, 1, writes % 4096);
  }, 1);
  t.after(() => clearInterval(timer));

  await assert.rejects(
    loadInstalledSkin(themeDir, { platform: "macos", clientVersion: "2.0.0" }),
    /changed while (?:it was being read|being read)/,
  );
  clearInterval(timer);
  assert.ok(writes > 0, "test must mutate the real package file during loading");
});

test("deep-freezes the loaded skin against caller mutation", async () => {
  const { loadInstalledSkin } = requireLoader();
  const skin = await loadInstalledSkin(fixture("v1-static"), {
    platform: "macos",
    clientVersion: "2.0.0",
  });

  assert.equal(Object.isFrozen(skin), true);
  assert.equal(Object.isFrozen(skin.theme), true);
  assert.equal(Object.isFrozen(skin.theme.audio.ui.events), true);
  assert.equal(Object.isFrozen(skin.declaredFiles), true);
  assert.throws(() => { skin.theme.name = "mutated"; }, TypeError);
  assert.throws(() => skin.declaredFiles.push("extra"), TypeError);
});

test("the official package validator delegates v1 semantics to the shared loader contract", async () => {
  const packageValidator = await import(packageValidatorUrl);
  assert.equal(typeof packageValidator.validateOfficialThemeDefinition, "function");
  const raw = JSON.parse(await fs.readFile(path.join(fixture("v1-static"), "theme.json"), "utf8"));
  raw.image = "background.webp";

  const normalized = packageValidator.validateOfficialThemeDefinition(raw);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(Object.isFrozen(normalized), true);

  raw.executable = "skin.js";
  assert.throws(
    () => packageValidator.validateOfficialThemeDefinition(raw),
    /unsupported field executable/,
  );
});

test("rejects case-fold package collisions before adapting v1", () => {
  const { normalizePackageFileList } = requireLoader();
  assert.throws(
    () => normalizePackageFileList(["theme.json", "Background.webp", "background.webp"]),
    /case-fold collision.*Background\.webp.*background\.webp/i,
  );
});
