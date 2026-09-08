import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DYNAMIC_SETTINGS, parseDynamicSettings } from "../assets/dynamic/settings.mjs";
import { createThemeLibraryController } from "../scripts/theme-library-controller.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { scanThemeLibrary } from "../scripts/injector.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function libraryFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dream-controller-中文 ")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let libraryRoot = path.join(root, "themes");
  await fs.mkdir(libraryRoot);
  for (const name of ["one", "two"]) {
    const directory = path.join(libraryRoot, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "visual.png"), png);
    await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({ schemaVersion: 2,
      id: `local.controller.${name}`, name, version: "1.0.0", capabilities: [],
      visual: { kind: "image", asset: "visual.png", fit: "cover", opacity: 1 },
      audio: { ambient: { source: "none", loop: true, volume: .7, analyze: false }, ui: { volume: .8, events: {} } }, tokens: {} }));
  }
  let current;
  let generation = 0;
  const refreshes = [];
  let failReason = null;
  const refreshPayload = async (directory, reason, mode = current?.displayMode ?? "theme") => {
    refreshes.push(reason);
    if (reason === failReason) throw new Error("injected renderer failure");
    const loaded = await loadInstalledSkin(directory, { platform: "windows", clientVersion: "2.0.0" });
    const scanned = await scanThemeLibrary(libraryRoot);
    current = { ...loaded, themeDir: directory, themeDirectories: scanned.themeDirectories,
      revision: String(++generation), displayMode: mode };
  };
  await refreshPayload(path.join(libraryRoot, "one"), "initial");
  const options = { getCurrent: () => current, getLibraryRoot: () => libraryRoot,
    setLibraryRoot: (next) => { libraryRoot = next; }, refreshPayload,
    stateRoot: root, storagePreference: path.join(root, "theme-storage.json") };
  return { root, options, refreshes, current: () => current, libraryRoot: () => libraryRoot,
    fail: (reason) => { failReason = reason; },
    request: (action, extra = {}) => ({ action, themeId: current.theme.id, generation: current.revision, ...extra }) };
}

test("renderer settings requests persist actual validated settings without switching themes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-controller-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = path.join(root, "settings.json");
  const current = { theme: { id: "local.test.one" }, revision: "current", themeDir: root };
  const controller = createThemeLibraryController({ getCurrent: () => current, settings,
    refreshPayload: () => { throw new Error("Settings must not reinject"); } });
  const request = { action: "save-settings", themeId: "local.test.one", generation: "current",
    settings: { ...DEFAULT_DYNAMIC_SETTINGS, masterVolume: .13 } };
  await controller.apply(request);
  assert.equal(parseDynamicSettings(await fs.readFile(settings, "utf8")).masterVolume, .13);
  await controller.apply({ ...request, generation: "stale", settings: DEFAULT_DYNAMIC_SETTINGS });
  assert.equal(parseDynamicSettings(await fs.readFile(settings, "utf8")).masterVolume, .13);
});

test("cancelled media selection leaves theme and library unchanged", async () => {
  const states = [];
  const current = { theme: { id: "local.test.one" }, revision: "current" };
  const controller = createThemeLibraryController({ getCurrent: () => current,
    getLibraryRoot: () => "/unused", chooseMedia: async () => null,
    presentStatus: async (_token, state) => states.push(state),
    refreshPayload: () => { throw new Error("No switch on cancellation"); } });
  await controller.apply({ action: "import-media", themeId: current.theme.id, generation: current.revision });
  assert.deepEqual(states, ["loading", "cancelled"]);
});

test("restore uses native display mode and theme selection refuses unknown catalog IDs", async () => {
  let mode = "theme";
  const current = { theme: { id: "local.test.one" }, revision: "current", themeDir: "/theme",
    themeDirectories: new Map([["local.test.one", "/theme"]]) };
  const controller = createThemeLibraryController({ getCurrent: () => current,
    refreshPayload: async (directory, _reason, nextMode) => {
      assert.equal(directory, "/theme"); mode = nextMode;
    } });
  await controller.apply({ action: "restore-default-theme", themeId: current.theme.id, generation: current.revision });
  assert.equal(mode, "native");
  await assert.rejects(controller.select("local.test.missing"), /unavailable/);
  await controller.select("local.test.one");
  assert.equal(mode, "theme");
});

test("controller imports actual media, exposes it in the catalog, and activates it", async (t) => {
  const fixture = await libraryFixture(t);
  const source = path.join(fixture.root, "新的 图片.png");
  await fs.writeFile(source, png);
  const controller = createThemeLibraryController({ ...fixture.options, chooseMedia: async () => source });
  await controller.apply(fixture.request("import-media"));
  assert.equal(fixture.current().theme.name, "新的 图片");
  assert.equal(fixture.current().themeDirectories.size, 3);
  assert.equal(path.dirname(fixture.current().themeDir), fixture.libraryRoot());
  assert.deepEqual(await fs.readFile(source), png);
});

test("controller deleting the active theme selects a fallback and archives recoverably", async (t) => {
  const fixture = await libraryFixture(t);
  const previous = fixture.current().themeDir;
  const controller = createThemeLibraryController(fixture.options);
  await controller.apply(fixture.request("delete-theme", { targetThemeId: fixture.current().theme.id }));
  assert.equal(fixture.current().theme.id, "local.controller.two");
  assert.equal(fixture.current().themeDirectories.size, 1);
  await assert.rejects(fs.stat(previous), { code: "ENOENT" });
  assert.equal((await fs.readdir(path.join(fixture.libraryRoot(), ".deleted"))).length, 1);
});

test("controller restores archived files and original selection if catalog commit fails", async (t) => {
  const fixture = await libraryFixture(t);
  const previous = fixture.current().themeDir;
  fixture.fail("delete-theme-catalog-refresh");
  const controller = createThemeLibraryController(fixture.options);
  await assert.rejects(controller.apply(fixture.request("delete-theme", { targetThemeId: fixture.current().theme.id })), /injected renderer failure/);
  assert.equal(fixture.current().theme.id, "local.controller.one");
  assert.equal(fixture.current().themeDirectories.size, 2);
  assert.ok((await fs.stat(previous)).isDirectory());
});

test("controller commits library migration only after the renderer accepts copied assets", async (t) => {
  const fixture = await libraryFixture(t);
  const previous = fixture.libraryRoot();
  const destination = path.join(fixture.root, "新 素材库");
  await fs.mkdir(destination);
  const controller = createThemeLibraryController({ ...fixture.options, chooseDirectory: async () => destination });
  await controller.apply(fixture.request("change-storage"));
  assert.equal(fixture.libraryRoot(), destination);
  assert.equal(fixture.current().themeDir, path.join(destination, "one"));
  const preference = JSON.parse(await fs.readFile(fixture.options.storagePreference, "utf8"));
  assert.equal(preference.libraryRoot, destination);
  assert.deepEqual(await fs.readdir(previous), []);
  assert.equal(fixture.current().themeDirectories.size, 2);
});

test("controller failed migration preserves source and rolls back staged destination", async (t) => {
  const fixture = await libraryFixture(t);
  const previous = fixture.libraryRoot();
  const destination = path.join(fixture.root, "rollback destination");
  await fs.mkdir(destination);
  fixture.fail("storage-migration");
  const controller = createThemeLibraryController({ ...fixture.options, chooseDirectory: async () => destination });
  await assert.rejects(controller.apply(fixture.request("change-storage")), /injected renderer failure/);
  assert.equal(fixture.libraryRoot(), previous);
  assert.equal(fixture.current().themeDir, path.join(previous, "one"));
  assert.equal((await fs.readdir(previous)).length, 2);
  assert.deepEqual(await fs.readdir(destination), []);
  await assert.rejects(fs.stat(fixture.options.storagePreference), { code: "ENOENT" });
});
