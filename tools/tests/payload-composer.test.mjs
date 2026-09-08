import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { DEFAULT_DYNAMIC_SETTINGS } from "../../runtime/dynamic/settings.mjs";
import { collectThemeAssetPaths } from "../../runtime/dynamic/theme-contract.mjs";
import { loadInstalledSkin } from "../../runtime/dynamic/theme-loader.mjs";
import {
  loadDynamicModuleBundle as loadMacBundle,
  loadPayload as loadMacPayload,
} from "../../macos/scripts/injector.mjs";
import {
  loadDynamicModuleBundle as loadWindowsBundle,
  loadPayload as loadWindowsPayload,
} from "../../windows/scripts/injector.mjs";

const composerUrl = new URL("../../runtime/dynamic/payload-composer.mjs", import.meta.url);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = path.join(projectRoot, "tools/tests/fixtures/themes");
const browserRoot = path.join(projectRoot, "runtime/dynamic/browser");

let composerModule = null;
try {
  composerModule = await import(composerUrl);
} catch {
  // The first TDD run intentionally reaches requireComposer before implementation exists.
}

function requireComposer() {
  assert.ok(composerModule, "dynamic payload composer module must exist");
  return composerModule;
}

function digest(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function dynamicModules() {
  return Promise.all(["module-registry.js", "entry.js"].map(async (name) => {
    const source = await fs.readFile(path.join(browserRoot, name), "utf8");
    return { name, sha256: digest(source), source };
  }));
}

function deferredAssetUrls(theme) {
  return Object.fromEntries(collectThemeAssetPaths(theme).map((asset, index) => [
    asset,
    `dream-skin-deferred://asset/${index}`,
  ]));
}

async function videoSkin(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-payload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(fixtureRoot, "v2-video"), root, { recursive: true });
  for (const asset of [
    "audio/ui/approval.wav",
    "audio/ui/completed.wav",
    "audio/ui/error.wav",
    "media/loop.mp4",
    "media/poster.webp",
  ]) {
    const target = path.join(root, asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${asset}\n`);
  }
  await fs.mkdir(path.join(root, "styles"), { recursive: true });
  await fs.writeFile(
    path.join(root, "styles/theme.css"),
    '[data-ds-part="composer"] { border-color: var(--ds-theme-color-line); }\n',
  );
  return loadInstalledSkin(root, { platform: "macos", clientVersion: "2.0.0" });
}

function tinyPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

test("storage display accepts absolute Mac and Windows paths but not relative or device paths", async () => {
  const { composeDynamicPayload } = requireComposer();
  const loadedSkin = await loadInstalledSkin(path.join(fixtureRoot, "v1-static"), {
    platform: "windows", clientVersion: "2.0.0",
  });
  const input = { loadedSkin, settings: DEFAULT_DYNAMIC_SETTINGS,
    assetUrls: deferredAssetUrls(loadedSkin.theme), revision: "storage-path-test",
    modules: await dynamicModules() };
  for (const storagePath of ["/opt/themes", "C:\\Users\\Example\\主题库", "D:/Themes", "\\\\server\\share\\Themes"]) {
    const result = composeDynamicPayload({ ...input, storage: {
      path: storagePath, available: true, custom: true, bytes: 0, themeCount: 1,
    } });
    assert.equal(result.config.storage.path, storagePath);
  }
  for (const storagePath of ["themes", "C:themes", "\\themes", "\\\\?\\C:\\Themes", "\\\\.\\pipe\\test", "\\\\server", "C:\\bad\npath"]) {
    assert.throws(() => composeDynamicPayload({ ...input, storage: {
      path: storagePath, available: true, custom: true, bytes: 0, themeCount: 1,
    } }), /storage status is invalid/);
  }
});

async function executableVideoSkin(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-injector-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(fixtureRoot, "v2-video"), root, { recursive: true });
  const themePath = path.join(root, "theme.json");
  const theme = JSON.parse(await fs.readFile(themePath, "utf8"));
  theme.visual.poster = "media/poster.png";
  await fs.writeFile(themePath, `${JSON.stringify(theme, null, 2)}\n`);
  for (const asset of [
    "audio/ui/approval.wav", "audio/ui/completed.wav", "audio/ui/error.wav", "media/loop.mp4",
  ]) {
    const target = path.join(root, asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${asset}\n`);
  }
  await fs.writeFile(path.join(root, "media/poster.png"), tinyPng());
  await fs.mkdir(path.join(root, "styles"), { recursive: true });
  await fs.writeFile(path.join(root, "styles/theme.css"), '[data-ds-part="composer"] { opacity: .9; }\n');
  return root;
}

test("composes deterministic v1-adapter and v2 payloads without filesystem paths", async (t) => {
  const { composeDynamicPayload } = requireComposer();
  const modules = await dynamicModules();
  const v1 = await loadInstalledSkin(path.join(fixtureRoot, "v1-static"), {
    platform: "windows",
    clientVersion: "2.0.0",
  });
  const v2 = await videoSkin(t);

  for (const loadedSkin of [v1, v2]) {
    const input = {
      loadedSkin,
      settings: DEFAULT_DYNAMIC_SETTINGS,
      assetUrls: deferredAssetUrls(loadedSkin.theme),
      revision: `revision-${loadedSkin.sourceApiVersion}`,
      modules,
    };
    const first = composeDynamicPayload(input);
    const second = composeDynamicPayload(input);

    assert.equal(first.source, second.source);
    assert.equal(first.sha256, digest(first.source));
    assert.deepEqual(first.config, second.config);
    assert.equal(first.config.sourceApiVersion, loadedSkin.sourceApiVersion);
    assert.equal(first.config.activation, "deferred");
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.config), true);
    assert.doesNotMatch(first.source, /file:\/\//i);
    assert.equal(first.source.includes(fixtureRoot), false);
  }
});

test("deferred v2 payload creates no DOM, media, audio, or WebGL object", async (t) => {
  const { composeDynamicPayload } = requireComposer();
  const loadedSkin = await videoSkin(t);
  const composed = composeDynamicPayload({
    loadedSkin,
    settings: DEFAULT_DYNAMIC_SETTINGS,
    assetUrls: deferredAssetUrls(loadedSkin.theme),
    revision: "deferred-runtime",
    modules: await dynamicModules(),
  });
  const rootState = { cleanup: () => true };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });

  vm.runInContext(composed.source, context);

  assert.equal(context.document, undefined);
  assert.equal(context.HTMLMediaElement, undefined);
  assert.equal(context.AudioContext, undefined);
  assert.equal(context.WebGL2RenderingContext, undefined);
  assert.equal(rootState.dynamic.activation, "deferred");
  assert.deepEqual(Array.from(rootState.dynamic.modules), []);
});

test("rejects missing or extra asset URL keys", async (t) => {
  const { composeDynamicPayload } = requireComposer();
  const loadedSkin = await videoSkin(t);
  const modules = await dynamicModules();
  const urls = deferredAssetUrls(loadedSkin.theme);
  const missing = { ...urls };
  delete missing[Object.keys(missing)[0]];

  assert.throws(
    () => composeDynamicPayload({
      loadedSkin,
      settings: DEFAULT_DYNAMIC_SETTINGS,
      assetUrls: missing,
      revision: "missing-asset",
      modules,
    }),
    (error) => error?.code === "ASSET_URL_KEYS",
  );
  assert.throws(
    () => composeDynamicPayload({
      loadedSkin,
      settings: DEFAULT_DYNAMIC_SETTINGS,
      assetUrls: { ...urls, "media/extra.webp": "dream-skin-deferred://asset/extra" },
      revision: "extra-asset",
      modules,
    }),
    (error) => error?.code === "ASSET_URL_KEYS",
  );
});

test("rejects out-of-order and source-hash-mismatched module bundles", async (t) => {
  const { composeDynamicPayload } = requireComposer();
  const loadedSkin = await videoSkin(t);
  const modules = await dynamicModules();
  const base = {
    loadedSkin,
    settings: DEFAULT_DYNAMIC_SETTINGS,
    assetUrls: deferredAssetUrls(loadedSkin.theme),
    revision: "module-integrity",
  };

  assert.throws(
    () => composeDynamicPayload({ ...base, modules: [...modules].reverse() }),
    (error) => error?.code === "MODULE_ORDER",
  );
  assert.throws(
    () => composeDynamicPayload({
      ...base,
      modules: [{ ...modules[0], sha256: "0".repeat(64) }, modules[1]],
    }),
    (error) => error?.code === "MODULE_HASH",
  );
});

test("both injectors append deferred v2 runtime while leaving v1 on the legacy path", async (t) => {
  const v2Root = await executableVideoSkin(t);
  const [macV2, windowsV2, macV1, windowsV1] = await Promise.all([
    loadMacPayload(v2Root),
    loadWindowsPayload(v2Root),
    loadMacPayload(),
    loadWindowsPayload(),
  ]);
  for (const loaded of [macV2, windowsV2]) {
    assert.equal(loaded.sourceApiVersion, 2);
    assert.equal(loaded.activation, "deferred");
    assert.match(loaded.payload, /__startCodexDynamicSkin/);
    assert.doesNotMatch(loaded.payload, /file:\/\//i);
    assert.equal(loaded.payload.includes(v2Root), false);
  }
  for (const loaded of [macV1, windowsV1]) {
    assert.doesNotMatch(loaded.payload, /__startCodexDynamicSkin/);
  }
});

test("both platform bundle loaders reject a manifest/source hash mismatch", async (t) => {
  for (const [platform, loader] of [["macos", loadMacBundle], ["windows", loadWindowsBundle]]) {
    const engineRoot = await fs.mkdtemp(path.join(os.tmpdir(), `codex-dynamic-${platform}-bundle-`));
    t.after(() => fs.rm(engineRoot, { recursive: true, force: true }));
    await fs.cp(path.join(projectRoot, platform, "assets"), path.join(engineRoot, "assets"), {
      recursive: true,
    });
    await fs.appendFile(path.join(engineRoot, "assets/dynamic/browser/entry.js"), "\n// tampered\n");
    await assert.rejects(loader(engineRoot), /does not match its SHA-256 digest/);
  }
});

test("module bundle loader rejects a module reached through a symbolic link", async (t) => {
  const engineRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-linked-bundle-"));
  t.after(() => fs.rm(engineRoot, { recursive: true, force: true }));
  await fs.cp(path.join(projectRoot, "macos/assets"), path.join(engineRoot, "assets"), {
    recursive: true,
  });
  const entryPath = path.join(engineRoot, "assets/dynamic/browser/entry.js");
  const externalPath = path.join(engineRoot, "external-entry.js");
  await fs.copyFile(entryPath, externalPath);
  await fs.rm(entryPath);
  await fs.symlink(externalPath, entryPath);
  await assert.rejects(loadMacBundle(engineRoot), /must not traverse a symbolic link/);
});
