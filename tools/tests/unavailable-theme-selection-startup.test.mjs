import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DYNAMIC_SETTINGS } from "../../macos/assets/dynamic/settings.mjs";
import { createThemeLibraryController } from "../../windows/scripts/theme-library-controller.mjs";

// Execute the real startup and switch-commit bodies, but stop before either
// platform opens CDP or starts a watcher. Storage, selection, package loading,
// and selection writes remain real; every writable path belongs to the fixture.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function section(source, start, end, from = 0) {
  const first = source.indexOf(start, from);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing offline boundary: ${start}`);
  return source.slice(first, last);
}

async function startup(platform, options) {
  const scripts = new URL(`../../${platform}/scripts/`, import.meta.url);
  const injector = await import(new URL("injector.mjs", scripts));
  const selection = await import(new URL("theme-selection-store.mjs", scripts));
  const storage = await import(new URL("theme-storage-actions.mjs", scripts));
  const source = await fs.readFile(new URL("injector.mjs", scripts), "utf8");
  const owner = source.indexOf("async function runOwnedWatch(options)");
  assert.ok(owner >= 0);
  const metrics = { payloadLoads: 0 };
  const dependencies = { options, fs, metrics, createThemeLibraryController, ...injector, ...selection, ...storage,
    loadPayloadForOptions: (...args) => {
      metrics.payloadLoads++;
      return injector.loadPayloadForOptions(...args);
    },
  };
  let body;
  if (platform === "macos") {
    const initialize = section(source, "  const defaultThemeLibrary =", '  debugTrace("watch-start",', owner);
    const refresh = section(source, "  const refreshPayload =", "  const queuePayloadRefresh =", owner);
    const storageAction = section(source, '    if (request.action === "change-storage") {',
      '    if (!activeThemeLibrary) throw new Error("Theme library storage is unavailable");', owner);
    body = `
      const debugTrace = () => {};
      ${initialize}
      const sessions = new Map();
      const mutationEpoch = 0;
      let controlOnly = false;
      const watchSelectedTheme = () => {}; // Deliberately no filesystem watcher.
      ${refresh}
      return {
        themeId: current.theme.id, displayMode,
        switchTheme: (directory, mode, reason = "renderer-request") => refreshPayload(directory, reason, mode),
        refresh: (reason) => refreshPayload(undefined, reason),
        revision: () => current.revision,
        pause: () => { controlOnly = true; },
        migrate: async (destination) => {
          const chooseThemeLibraryDirectory = async () => destination;
          const nextOperationToken = () => "fixture-storage";
          const presentLibraryActionStatus = async () => {}; // No native status UI.
          const request = { action: "change-storage", themeId: current.theme.id };
          ${storageAction}
        },
      };
    `;
  } else {
    const initialize = section(source, "    loadedPayload = await loadPayloadForOptions(", "    lastStrongThemeAuditAt =", owner);
    const refresh = section(source, "  const loadWatchedPayload =", "  const libraryController =", owner);
    const externalSelection = section(source, "  const applyExternalSelection =", "  const auditThemeSource =", owner);
    const resumeCommit = section(source, "        if (payloadChanged) await previousPayload", "        console.log(paused ?", owner);
    body = `
      const selectionFile = themeSelectionPath({ pauseFile: options.pauseFile,
        settingsPath: options.settings, themeLibrary: options.themeLibrary });
      let loadedPayload, selectedThemeDir, activeThemeLibrary, displayMode;
      let libraryMutation = false;
      let rejectedExternalSelectionKey = null;
      const paused = false;
      const sessions = new Map();
      const recoveryQueues = new Map();
      const readyTargets = new Set();
      const earlyScripts = new Map();
      const fallbackTargets = new Map();
      ${refresh}
      ${initialize}
      ${externalSelection}
      return {
        themeId: loadedPayload.theme.id, displayMode,
        switchTheme: (directory, mode, reason = "renderer-request") => refreshPayload(directory, reason, mode),
        refresh: (reason) => refreshPayload(undefined, reason),
        revision: () => loadedPayload.revision,
        loadCount: () => metrics.payloadLoads,
        pollSelection: applyExternalSelection,
        migrate: async (destination) => {
          const controller = createThemeLibraryController({
            getCurrent: () => loadedPayload,
            getLibraryRoot: () => activeThemeLibrary,
            setLibraryRoot: (directory) => { activeThemeLibrary = directory; },
            refreshPayload, settings: options.settings,
            storagePreference: themeStoragePreferencePath({ settingsPath: options.settings,
              themeLibrary: options.themeLibrary }),
            chooseDirectory: async () => destination, // Fixture choice; never opens a native dialog.
          });
          return controller.apply({ action: "change-storage", themeId: loadedPayload.theme.id,
            generation: loadedPayload.revision });
        },
        resume: async () => {
          const previousPayload = loadedPayload;
          loadedPayload = await loadWatchedPayload(selectedThemeDir, displayMode);
          const payloadChanged = true;
          ${resumeCommit}
        },
      };
    `;
  }
  return new AsyncFunction(...Object.keys(dependencies), body)(...Object.values(dependencies));
}

async function writeTheme(directory, id) {
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(new URL("fixtures/media/tiny.webp", import.meta.url), path.join(directory, "background.webp"));
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({
    schemaVersion: 2, id, name: id, version: "1.0.0", capabilities: [],
    visual: { kind: "image", asset: "background.webp", fit: "cover", opacity: 1 },
    audio: { ambient: { source: "none", loop: true, volume: 0, analyze: false },
      ui: { volume: 0, events: {} } },
    tokens: {},
  }));
}

async function changeSettings(f, visualOpacity = 0.6) {
  await fs.writeFile(f.options.settings, JSON.stringify({ ...DEFAULT_DYNAMIC_SETTINGS, visualOpacity }));
}

async function fixture(t, { mounted = false, selected = true, mode = "theme" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-unavailable-selection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const external = path.join(root, "External Disk", "themes");
  const selectedDirectory = path.join(external, "selected");
  const themeDir = path.join(root, "fallback");
  const themeLibrary = path.join(root, "themes");
  const selectionFile = path.join(root, "selected-theme.json");
  await writeTheme(themeDir, "test.local-fallback");
  await fs.mkdir(themeLibrary);
  if (mounted) await writeTheme(selectedDirectory, "test.external-selected");
  await fs.writeFile(path.join(root, "theme-storage.json"), JSON.stringify({ schemaVersion: 1, libraryRoot: external }));
  const originalSelection = `${JSON.stringify({
    schema: "codex-dream-skin-selected-theme/2", themeId: "test.external-selected", mode,
  })}\n`;
  if (selected) await fs.writeFile(selectionFile, originalSelection);
  return { root, selectionFile, originalSelection, selectedDirectory,
    options: { themeDir, themeLibrary, settings: path.join(root, "dynamic-settings.json") } };
}

for (const platform of ["macos", "windows"]) {
  for (const mode of ["theme", "native"]) {
    test(`${platform} cold-start fallback preserves an unavailable external selection in ${mode} mode`, async (t) => {
      const f = await fixture(t, { mode });
      const running = await startup(platform, f.options);
      assert.equal(running.themeId, "test.local-fallback");
      assert.equal(running.displayMode, mode);
      // The old bug rewrites this real file to test.local-fallback at startup.
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
      await writeTheme(f.selectedDirectory, "test.external-selected");
      const remounted = await startup(platform, f.options);
      assert.equal(remounted.themeId, "test.external-selected");
      assert.equal(remounted.displayMode, mode);
    });
  }

  test(`${platform} available library still restores and commits the selected theme`, async (t) => {
    const f = await fixture(t, { mounted: true });
    assert.equal((await startup(platform, f.options)).themeId, "test.external-selected");
    assert.equal(JSON.parse(await fs.readFile(f.selectionFile, "utf8")).themeId, "test.external-selected");
  });

  for (const reason of ["renderer-request", ...(platform === "macos" ? ["settings-and-theme-save"] : [])]) {
    test(`${platform} an explicit ${reason} switch after unavailable-library startup still commits`, async (t) => {
      const f = await fixture(t);
      const running = await startup(platform, f.options);
      const chosen = path.join(f.root, "explicit-choice");
      await writeTheme(chosen, "test.explicit-choice");
      await running.switchTheme(chosen, "native", reason);
      assert.deepEqual(JSON.parse(await fs.readFile(f.selectionFile, "utf8")), {
        schema: "codex-dream-skin-selected-theme/2", themeId: "test.explicit-choice", mode: "native",
      });
      // Successful user intent ends fallback protection for subsequent refreshes.
      await fs.unlink(f.selectionFile);
      await changeSettings(f);
      await running.refresh();
      assert.equal(JSON.parse(await fs.readFile(f.selectionFile, "utf8")).themeId, "test.explicit-choice");
    });
  }

  for (const cause of ["settings", "asset", ...(platform === "macos" ? ["paused-settings"] : [])]) {
    test(`${platform} unavailable-library fallback does not persist on automatic ${cause} refresh`, async (t) => {
      const f = await fixture(t);
      const running = await startup(platform, f.options);
      // Isolate this second write from the separate startup regression.
      await fs.writeFile(f.selectionFile, f.originalSelection);
      const revision = running.revision();
      if (cause === "asset") {
        const manifestFile = path.join(f.options.themeDir, "theme.json");
        const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
        await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, name: "Changed local asset metadata" }));
      } else {
        await changeSettings(f);
        if (cause === "paused-settings") running.pause();
      }
      await running.refresh();
      assert.notEqual(running.revision(), revision, "a real payload refresh must have occurred");
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
    });
  }

  test(`${platform} background refresh reasons cannot unlock unavailable selection protection`, async (t) => {
    const f = await fixture(t);
    const running = await startup(platform, f.options);
    await fs.writeFile(f.selectionFile, f.originalSelection);
    for (const [index, reason] of ["profile-module-activation", "future-background-refresh"].entries()) {
      const revision = running.revision();
      await changeSettings(f, 0.5 + index / 10);
      await running.refresh(reason);
      assert.notEqual(running.revision(), revision);
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
    }
  });

  for (const reason of ["storage-migration", "storage-migration-rollback"]) {
    test(`${platform} ${reason} refresh preserves a pending unavailable selection`, async (t) => {
      const f = await fixture(t);
      const running = await startup(platform, f.options);
      const revision = running.revision();
      await changeSettings(f);
      await running.refresh(reason);
      assert.notEqual(running.revision(), revision);
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
    });
  }

  test(`${platform} failed storage-preference commit cannot replace the unavailable selection`, async (t) => {
    const f = await fixture(t);
    const running = await startup(platform, f.options);
    const destination = path.join(f.root, "recovered-library");
    await writeTheme(path.join(destination, "fallback"), "test.local-fallback");
    // The real atomic preference writer must fail at rename after the payload
    // refresh, not at loading or validation. All state is confined to this fixture.
    const preference = path.join(f.root, "theme-storage.json");
    await fs.unlink(preference);
    await fs.mkdir(preference);
    await fs.writeFile(path.join(preference, "block-replacement"), "fixture");
    await assert.rejects(() => running.migrate(destination),
      (error) => ["EISDIR", "ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code));
    assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
  });

  if (platform === "windows") {
    test("windows automatic saved-selection poll cannot persist an unresolved fallback", async (t) => {
      const f = await fixture(t, { mode: "native" });
      const running = await startup(platform, f.options);
      await fs.writeFile(f.selectionFile, f.originalSelection);
      await changeSettings(f);
      const loads = running.loadCount();
      await running.pollSelection();
      await running.pollSelection();
      assert.equal(running.loadCount(), loads, "known-unmounted storage needs no payload rebuild on each poll");
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
      // Merely mounting the directory does not resolve an absent theme ID.
      await fs.mkdir(path.dirname(f.selectedDirectory), { recursive: true });
      await running.pollSelection();
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
      // A later mount must be retried even though the saved file did not change.
      await writeTheme(f.selectedDirectory, "test.external-selected");
      await running.pollSelection();
      assert.equal(JSON.parse(await fs.readFile(f.selectionFile, "utf8")).themeId, "test.external-selected");
    });

    test("windows resume commit preserves the unavailable-library selection", async (t) => {
      const f = await fixture(t);
      const running = await startup(platform, f.options);
      await fs.writeFile(f.selectionFile, f.originalSelection);
      await changeSettings(f);
      await running.resume();
      assert.equal(await fs.readFile(f.selectionFile, "utf8"), f.originalSelection);
    });
  }

  test(`${platform} startup without a previous selection can still seed the fallback`, async (t) => {
    const f = await fixture(t, { selected: false });
    assert.equal((await startup(platform, f.options)).themeId, "test.local-fallback");
    assert.equal(JSON.parse(await fs.readFile(f.selectionFile, "utf8")).themeId, "test.local-fallback");
  });
}
