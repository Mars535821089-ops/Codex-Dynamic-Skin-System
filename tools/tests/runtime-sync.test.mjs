import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch as watchFs } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { isStaticPayloadWatchFilename } from "../../macos/scripts/injector.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserRoot = path.join(projectRoot, "runtime/dynamic/browser");
const syncTool = path.join(projectRoot, "tools/sync-runtime-assets.mjs");
const expectedModules = ["module-registry.js", "media-layer.js", "audio-bus.js", "performance-policy.js",
  "signal-model.js", "voxel-field.js", "semantic-events.js", "controls.js",
  "controller.js", "entry.js"];
const manifestName = "dynamic-runtime-manifest.json";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readSource(name) {
  return fs.readFile(path.join(browserRoot, name), "utf8");
}

async function runSyncTool(toolPath, cwd) {
  const child = spawn(process.execPath, [toolPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, Buffer.concat(stderr).toString("utf8"));
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8") || Buffer.concat(stdout).toString("utf8"));
}

function validConfig(moduleNames, overrides = {}) {
  return {
    protocolVersion: 1,
    generation: "test-generation",
    activation: "deferred",
    displayMode: "theme",
    assetTransport: "deferred",
    assets: { "media/poster.webp": "dream-skin-deferred://asset/0" },
    theme: {
      schemaVersion: 2,
      capabilities: [],
      visual: { kind: "image", asset: "media/poster.webp" },
      audio: { ambient: { source: "none" }, ui: { events: {} } },
    },
    moduleHashes: moduleNames.map((name, index) => ({
      name,
      sha256: String(index + 1).padStart(64, "0"),
    })),
    ...overrides,
  };
}

test("native display mode removes the injected root and keeps controller and controls", async () => {
  const cleanupOrder = [];
  const rootState = {
    cleanup() {
      cleanupOrder.push("legacy");
      return true;
    },
  };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  const constructed = [];
  for (const name of ["controller", "controls", "media-layer", "audio-bus", "performance-policy"]) {
    context.__registerCodexDynamicSkinModule(name, () => {
      constructed.push(name);
      return {
        stage: async () => {},
        activate: () => true,
        cleanup: () => cleanupOrder.push(name),
      };
    });
  }
  vm.runInContext(await readSource("entry.js"), context);
  const moduleNames = [
    "module-registry.js", "controller.js", "controls.js", "media-layer.js",
    "audio-bus.js", "performance-policy.js", "entry.js",
  ];

  const native = await context.__startCodexDynamicSkin(validConfig(moduleNames, {
    activation: "active",
    displayMode: "native",
  }));

  assert.equal(context.__CODEX_DREAM_SKIN_STATE__, undefined);
  assert.equal(context.__CODEX_DYNAMIC_SKIN_NATIVE_STATE__, native);
  assert.deepEqual(constructed, ["controller", "controls"]);
  assert.deepEqual(Array.from(native.modules), ["controller", "controls"]);
  assert.equal(native.displayMode, "native");
  assert.equal(await native.cleanup(), true);
  assert.equal(context.__CODEX_DYNAMIC_SKIN_NATIVE_STATE__, undefined);
  assert.deepEqual(cleanupOrder, ["legacy", "controls", "controller"]);
});

test("sync manifest fixes module order and verifies both platform hashes", async () => {
  const sourceEntries = (await fs.readdir(browserRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(sourceEntries, [...expectedModules].sort(), "missing or extra browser module");

  const expectedManifest = {
    schema: "codex-dynamic-skin-runtime/1",
    modules: await Promise.all(expectedModules.map(async (name) => ({
      name,
      path: `dynamic/browser/${name}`,
      sha256: sha256(await readSource(name)),
    }))),
  };

  for (const platform of ["macos", "windows"]) {
    const assets = path.join(projectRoot, platform, "assets");
    const manifestText = await fs.readFile(path.join(assets, manifestName), "utf8");
    assert.equal(manifestText, `${JSON.stringify(expectedManifest, null, 2)}\n`);
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.modules.map(({ name }) => name), expectedModules);
    for (const module of manifest.modules) {
      const staged = await fs.readFile(path.join(assets, module.path), "utf8");
      assert.equal(staged, await readSource(module.name));
      assert.equal(sha256(staged), module.sha256);
    }
  }

  const result = spawnSync(process.execPath, [syncTool, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("runtime sync exposes only a complete old or new generation at commit signals", async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-runtime-sync."));
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all([
    fs.cp(path.join(projectRoot, "runtime"), path.join(fixtureRoot, "runtime"), { recursive: true }),
    fs.mkdir(path.join(fixtureRoot, "tools"), { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(syncTool, path.join(fixtureRoot, "tools", "sync-runtime-assets.mjs")),
    fs.copyFile(
      path.join(projectRoot, "tools", "selectors.json"),
      path.join(fixtureRoot, "tools", "selectors.json"),
    ),
  ]);

  const fixtureTool = path.join(fixtureRoot, "tools", "sync-runtime-assets.mjs");
  const cssPath = path.join(fixtureRoot, "runtime", "dream-skin.css");
  const rendererPath = path.join(fixtureRoot, "runtime", "renderer-inject.js");
  const controllerPath = path.join(fixtureRoot, "runtime", "dynamic", "browser", "controller.js");
  const largePadding = `\n/* generation-padding */${"x".repeat(4 * 1024 * 1024)}\n`;
  await fs.appendFile(cssPath, `${largePadding}/* generation-a */\n`);
  await fs.appendFile(rendererPath, "\n// generation-a\n");
  await fs.appendFile(controllerPath, "\n// generation-a\n");
  await runSyncTool(fixtureTool, fixtureRoot);

  const assetsRoot = path.join(fixtureRoot, "macos", "assets");
  const oldManifest = JSON.parse(await fs.readFile(path.join(assetsRoot, manifestName), "utf8"));
  const oldControllerHash = oldManifest.modules.find(({ name }) => name === "controller.js").sha256;
  await fs.writeFile(
    cssPath,
    (await fs.readFile(cssPath, "utf8")).replace("generation-a", "generation-b"),
  );
  await fs.writeFile(
    rendererPath,
    (await fs.readFile(rendererPath, "utf8")).replace("generation-a", "generation-b"),
  );
  await fs.writeFile(
    controllerPath,
    (await fs.readFile(controllerPath, "utf8")).replace("generation-a", "generation-b"),
  );
  const newControllerHash = sha256(await fs.readFile(controllerPath, "utf8"));
  assert.notEqual(newControllerHash, oldControllerHash);

  const snapshots = [];
  const pendingReads = [];
  const watcher = watchFs(assetsRoot, { persistent: false }, (_event, filename) => {
    const name = String(filename ?? "");
    if (!isStaticPayloadWatchFilename(name)) return;
    pendingReads.push((async () => {
      try {
        const [css, renderer, manifestText] = await Promise.all([
          fs.readFile(path.join(assetsRoot, "dream-skin.css"), "utf8"),
          fs.readFile(path.join(assetsRoot, "renderer-inject.js"), "utf8"),
          fs.readFile(path.join(assetsRoot, manifestName), "utf8"),
        ]);
        const manifest = JSON.parse(manifestText);
        const controllerHash = manifest.modules.find(({ name }) => name === "controller.js")?.sha256;
        const isOld = !css.includes("generation-b") && !renderer.includes("generation-b")
          && controllerHash === oldControllerHash;
        const isNew = css.includes("generation-b") && renderer.includes("generation-b")
          && controllerHash === newControllerHash;
        snapshots.push({ name, state: isOld ? "old" : isNew ? "new" : "mixed" });
      } catch (error) {
        snapshots.push({ name, state: "mixed", error: error.message });
      }
    })());
  });

  try {
    await runSyncTool(fixtureTool, fixtureRoot);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    watcher.close();
  }
  await Promise.all(pendingReads);

  assert.ok(snapshots.length > 0, "the final manifest replacement must publish one commit signal");
  assert.deepEqual(
    snapshots.filter(({ state }) => state === "mixed"),
    [],
    `watcher observed an uncommitted generation: ${JSON.stringify(snapshots)}`,
  );
  assert.ok(snapshots.some(({ state }) => state === "new"), "the new generation was never published");
});

test("module registry rejects invalid and duplicate names", async () => {
  const context = vm.createContext({});
  vm.runInContext(await readSource("module-registry.js"), context);
  const register = context.__registerCodexDynamicSkinModule;
  assert.equal(typeof register, "function");

  register("controller", () => ({}));
  assert.throws(() => register("controller", () => ({})), /Invalid or duplicate/);
  assert.throws(() => register("Controller", () => ({})), /Invalid or duplicate/);
  assert.throws(() => register("media-layer", {}), /Invalid or duplicate/);
});

test("entry constructs only theme-enabled modules and extends the owned root cleanup", async () => {
  const cleanupOrder = [];
  const rootState = {
    cleanup() {
      cleanupOrder.push("legacy");
      return true;
    },
  };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  const constructed = [];
  for (const name of ["controller", "media-layer", "audio-bus"]) {
    context.__registerCodexDynamicSkinModule(name, () => {
      constructed.push(name);
      return { stage: async () => {}, cleanup: () => cleanupOrder.push(name) };
    });
  }
  vm.runInContext(await readSource("entry.js"), context);
  const moduleNames = [
    "module-registry.js",
    "controller.js",
    "media-layer.js",
    "audio-bus.js",
    "entry.js",
  ];

  const dynamic = await context.__startCodexDynamicSkin(validConfig(moduleNames, { activation: "active" }));

  assert.equal(context.__CODEX_DREAM_SKIN_STATE__, rootState);
  assert.deepEqual(constructed, ["controller", "media-layer"]);
  assert.equal(rootState.dynamic, dynamic);
  assert.deepEqual(Array.from(dynamic.modules), ["controller", "media-layer"]);
  assert.equal(await rootState.cleanup(), true);
  assert.deepEqual(cleanupOrder, ["media-layer", "controller", "legacy"]);
  assert.equal(rootState.dynamic, undefined);
});

test("entry commits the staged theme identity without clearing the owned root", async () => {
  const rootState = {
    themeId: "theme-before",
    revision: "revision-before",
    cleanup() { return true; },
  };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  context.__registerCodexDynamicSkinModule("controller", () => ({
    async stage() {},
    cleanup() {},
  }));
  vm.runInContext(await readSource("entry.js"), context);

  await context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ], {
    activation: "active",
    generation: "revision-after",
    theme: {
      schemaVersion: 2,
      id: "theme-after",
      capabilities: [],
      visual: { kind: "image", asset: "media/poster.webp" },
      audio: { ambient: { source: "none" }, ui: { events: {} } },
    },
  }));

  assert.equal(rootState.themeId, "theme-after");
  assert.equal(rootState.revision, "revision-after");
});

test("entry atomically reveals the candidate before concealing the previous generation", async () => {
  const events = [];
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let created = 0;
  context.__registerCodexDynamicSkinModule("controller", () => {
    const id = ++created;
    return {
      async stage() { events.push(`stage:${id}`); },
      async activate() { events.push(`reveal:${id}`); },
      async conceal() { events.push(`conceal:${id}`); },
      async cleanup() { events.push(`cleanup:${id}`); },
    };
  });
  vm.runInContext(await readSource("entry.js"), context);
  const modules = ["module-registry.js", "controller.js", "entry.js"];

  await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-one",
  }));
  await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-two",
  }));

  assert.deepEqual(events, [
    "stage:1", "reveal:1",
    "stage:2", "reveal:2", "conceal:1", "cleanup:1",
  ]);
});

test("entry reuses an active generation only while its controller owns one visible root", async () => {
  async function run(fixture) {
    const events = [];
    const rootState = { cleanup() { return true; } };
    const body = {};
    const createRoot = (style = {}) => ({
      hidden: false,
      isConnected: true,
      parentNode: body,
      style: { display: "block", visibility: "visible", opacity: "1", ...style },
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
      },
    });
    const roots = fixture === "missing" ? []
      : fixture === "hidden" ? [createRoot({ visibility: "hidden" })]
        : fixture === "duplicate" ? [createRoot(), createRoot()] : [createRoot()];
    const document = {
      body,
      documentElement: { clientWidth: 1280, clientHeight: 720 },
      querySelectorAll(selector) {
        return selector === "[data-dynamic-skin-root]" ? roots : [];
      },
    };
    const context = vm.createContext({
      __CODEX_DREAM_SKIN_STATE__: rootState,
      document,
      innerHeight: 720,
      innerWidth: 1280,
      getComputedStyle(node) { return node.style; },
    });
    context.window = context;
    vm.runInContext(await readSource("module-registry.js"), context);
    let created = 0;
    context.__registerCodexDynamicSkinModule("controller", () => {
      const id = ++created;
      return {
        async stage() { events.push(`stage:${id}`); },
        activate() { events.push(`reveal:${id}`); },
        conceal() { events.push(`conceal:${id}`); },
        cleanup() { events.push(`cleanup:${id}`); },
        diagnostics() {
          return {
            phase: "active",
            modules: { "media-layer": { connected: true, revealed: true } },
          };
        },
      };
    });
    vm.runInContext(await readSource("entry.js"), context);
    const modules = ["module-registry.js", "controller.js", "entry.js"];
    const config = validConfig(modules, { activation: "active", generation: "stable" });
    const first = await context.__startCodexDynamicSkin(config);
    const second = await context.__startCodexDynamicSkin(config);
    return { created, events, first, second };
  }

  const healthy = await run("healthy");
  assert.equal(healthy.first, healthy.second);
  assert.equal(healthy.created, 1, "one visible owned root must remain an idempotent no-op");

  for (const fixture of ["missing", "hidden", "duplicate"]) {
    const unhealthy = await run(fixture);
    assert.notEqual(unhealthy.first, unhealthy.second);
    assert.equal(unhealthy.created, 2,
      `a ${fixture} same-generation owned root must be rebuilt`);
    assert.deepEqual(unhealthy.events, [
      "stage:1", "reveal:1",
      "stage:2", "reveal:2", "conceal:1", "cleanup:1",
    ]);
  }
});

test("entry discards an older activation that finishes after a newer theme commits", async () => {
  const events = [];
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let created = 0;
  let releaseFirstStage;
  const firstStage = new Promise((resolve) => { releaseFirstStage = resolve; });
  context.__registerCodexDynamicSkinModule("controller", () => {
    const id = ++created;
    return {
      async stage() {
        events.push(`stage:${id}`);
        if (id === 1) await firstStage;
      },
      async activate() { events.push(`reveal:${id}`); },
      async conceal() { events.push(`conceal:${id}`); },
      async cleanup() { events.push(`cleanup:${id}`); },
    };
  });
  vm.runInContext(await readSource("entry.js"), context);
  const modules = ["module-registry.js", "controller.js", "entry.js"];

  const older = context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-one",
    theme: { ...validConfig(modules).theme, id: "theme-one" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-two",
    theme: { ...validConfig(modules).theme, id: "theme-two" },
  }));
  releaseFirstStage();
  await older;

  assert.equal(rootState.dynamic, newer);
  assert.equal(rootState.themeId, "theme-two");
  assert.equal(rootState.revision, "generation-two");
  assert.deepEqual(events, [
    "stage:1", "stage:2", "reveal:2", "cleanup:1",
  ]);
});

test("entry prunes orphaned legacy media only after the replacement is visible", async () => {
  const events = [];
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  context.__registerCodexDynamicSkinModule("controller", () => ({
    async stage() { events.push("stage"); },
    async activate() { events.push("reveal"); },
    async pruneOrphanedMediaRoots() { events.push("prune"); return 1; },
    async cleanup() { events.push("cleanup"); },
  }));
  vm.runInContext(await readSource("entry.js"), context);

  await context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ], { activation: "active" }));

  assert.deepEqual(events, ["stage", "reveal", "prune"]);
});

test("entry restores the previous visible generation when candidate reveal fails", async () => {
  const events = [];
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let created = 0;
  context.__registerCodexDynamicSkinModule("controller", () => {
    const id = ++created;
    return {
      async stage() { events.push(`stage:${id}`); },
      async activate() {
        events.push(`reveal:${id}`);
        if (id === 2) throw new Error("candidate reveal failed");
      },
      async conceal() { events.push(`conceal:${id}`); },
      async cleanup() { events.push(`cleanup:${id}`); },
    };
  });
  vm.runInContext(await readSource("entry.js"), context);
  const modules = ["module-registry.js", "controller.js", "entry.js"];

  const previous = await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-one",
  }));
  await assert.rejects(context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-two",
  })), /candidate reveal failed/);

  assert.equal(rootState.dynamic, previous);
  assert.deepEqual(events, [
    "stage:1", "reveal:1",
    "stage:2", "reveal:2", "conceal:1", "cleanup:2", "reveal:1",
  ]);
});

test("entry keeps the committed candidate visible when stale generation cleanup fails", async () => {
  const events = [];
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let created = 0;
  context.__registerCodexDynamicSkinModule("controller", () => {
    const id = ++created;
    return {
      async stage() { events.push(`stage:${id}`); },
      async activate() { events.push(`reveal:${id}`); },
      async conceal() { events.push(`conceal:${id}`); },
      async cleanup() {
        events.push(`cleanup:${id}`);
        if (id === 1) throw new Error("stale cleanup failed");
      },
    };
  });
  vm.runInContext(await readSource("entry.js"), context);
  const modules = ["module-registry.js", "controller.js", "entry.js"];

  await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-one",
  }));
  const candidate = await context.__startCodexDynamicSkin(validConfig(modules, {
    activation: "active", generation: "generation-two",
  }));

  assert.equal(rootState.dynamic, candidate);
  assert.equal(rootState.revision, "generation-two");
  assert.deepEqual(events, [
    "stage:1", "reveal:1",
    "stage:2", "reveal:2", "conceal:1", "cleanup:1",
  ]);
});

test("failed staging preserves the previous committed theme identity", async () => {
  const rootState = {
    themeId: "theme-before",
    revision: "revision-before",
    cleanup() { return true; },
  };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  context.__registerCodexDynamicSkinModule("controller", () => ({
    async stage() { throw new Error("candidate failed"); },
    cleanup() {},
  }));
  vm.runInContext(await readSource("entry.js"), context);

  await assert.rejects(context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ], {
    activation: "active",
    generation: "revision-after",
    theme: {
      schemaVersion: 2,
      id: "theme-after",
      capabilities: [],
      visual: { kind: "image", asset: "media/poster.webp" },
      audio: { ambient: { source: "none" }, ui: { events: {} } },
    },
  })), /candidate failed/);

  assert.equal(rootState.themeId, "theme-before");
  assert.equal(rootState.revision, "revision-before");
});

test("entry enables the media layer for imported image themes", async () => {
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  const constructed = [];
  context.__registerCodexDynamicSkinModule("controller", () => ({
    async stage() {},
    cleanup() {},
  }));
  context.__registerCodexDynamicSkinModule("media-layer", () => {
    constructed.push("media-layer");
    return { cleanup() {} };
  });
  vm.runInContext(await readSource("entry.js"), context);

  const dynamic = await context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "media-layer.js", "entry.js",
  ], { activation: "active" }));

  assert.deepEqual(constructed, ["media-layer"]);
  assert.deepEqual(Array.from(dynamic.modules), ["controller", "media-layer"]);
});

test("entry revokes renderer-owned blob URLs only after media cleanup", async () => {
  const cleanupOrder = [];
  const rootState = { cleanup() { cleanupOrder.push("legacy"); return true; } };
  const context = vm.createContext({
    __CODEX_DREAM_SKIN_STATE__: rootState,
    URL: { revokeObjectURL(url) { cleanupOrder.push(`revoke:${url}`); } },
  });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  context.__registerCodexDynamicSkinModule("controller", () => ({
    stage: async () => {},
    cleanup: () => cleanupOrder.push("controller"),
  }));
  vm.runInContext(await readSource("entry.js"), context);

  await context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ], {
    activation: "active",
    assetTransport: "renderer-blob",
    assets: { "media/poster.webp": "blob:app://codex/poster" },
  }));
  await rootState.cleanup();

  assert.deepEqual(cleanupOrder, [
    "controller", "revoke:blob:app://codex/poster", "legacy",
  ]);
});

test("entry exposes a bounded diagnostic when active staging fails", async () => {
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  context.__registerCodexDynamicSkinModule("controller", () => ({
    async stage() {
      const error = new Error("asset URL and local path must not be exposed");
      error.code = "MEDIA_AUTOPLAY";
      throw error;
    },
    diagnostics() { return { phase: "idle" }; },
  }));
  vm.runInContext(await readSource("entry.js"), context);

  await assert.rejects(context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ], { activation: "active" })), /asset URL/);

  assert.equal(context.__CODEX_DYNAMIC_SKIN_LAST_ERROR__.code, "MEDIA_AUTOPLAY");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_LAST_ERROR__.name, "Error");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_LAST_ERROR__.message, undefined,
    "renderer diagnostics must not retain attacker-controlled paths or URLs");
  assert.equal(rootState.dynamic, undefined);
});

test("deferred activation constructs no registered module", async () => {
  const rootState = { cleanup() { return true; } };
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: rootState });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let constructed = 0;
  context.__registerCodexDynamicSkinModule("controller", () => {
    constructed += 1;
    return {};
  });
  vm.runInContext(await readSource("entry.js"), context);
  const dynamic = await context.__startCodexDynamicSkin(validConfig([
    "module-registry.js", "controller.js", "entry.js",
  ]));
  assert.equal(constructed, 0);
  assert.deepEqual(Array.from(dynamic.modules), []);
});

test("entry rejects an out-of-order module hash list before construction", async () => {
  const context = vm.createContext({ __CODEX_DREAM_SKIN_STATE__: { cleanup() {} } });
  context.window = context;
  vm.runInContext(await readSource("module-registry.js"), context);
  let constructed = 0;
  context.__registerCodexDynamicSkinModule("controller", () => {
    constructed += 1;
    return {};
  });
  vm.runInContext(await readSource("entry.js"), context);
  const config = validConfig(["controller.js", "module-registry.js", "entry.js"]);

  assert.throws(() => context.__startCodexDynamicSkin(config), /module hash order/i);
  assert.equal(constructed, 0);
});
