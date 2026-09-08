import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeV2Package } from "../../tools/tests/helpers/theme-fixtures.mjs";
import * as actions from "../scripts/theme-library-actions.mjs";
import * as storage from "../scripts/theme-storage-actions.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";

const media = fileURLToPath(new URL("../../tools/tests/fixtures/media/", import.meta.url));
const client = { platform: "windows", clientVersion: "2.0.0" };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-win-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function imageTheme(root, file = "tiny.png") {
  return actions.importMediaTheme({ libraryRoot: root, sourcePath: path.join(media, file) });
}
async function videoTheme(root, name = "video") {
  const result = await makeV2Package(root, name);
  await fs.rm(path.join(result.root, "manifest.json"));
  return result.root;
}

for (const file of ["tiny.png", "tiny.jpg", "tiny.webp", "tiny.gif"]) {
  test(`Windows ${file} import publishes validated original media once`, async (t) => {
    const root = await fixture(t);
    const imported = await imageTheme(root, file);
    const loaded = await loadInstalledSkin(imported.themeDir, client);
    assert.equal(loaded.theme.id, imported.themeId);
    assert.equal(loaded.sourceApiVersion, 2);
    assert.equal(loaded.theme.visual.kind, "image");
    assert.equal(await fs.readFile(path.join(imported.themeDir, loaded.theme.visual.asset), "hex"),
      await fs.readFile(path.join(media, file), "hex"));
    assert.ok(loaded.contentManifest.versionId);
    const duplicate = await imageTheme(root, file);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.themeDir, imported.themeDir);
    assert.equal((await fs.readdir(root)).length, 1);
  });
}

test("Windows video import creates a poster from frozen media and preserves audio", async (t) => {
  const root = await fixture(t);
  const imported = await actions.importMediaTheme({
    libraryRoot: root, sourcePath: path.join(media, "loop-h264.mp4"),
    createPoster: async (input, output) => {
      assert.match(path.basename(path.dirname(path.dirname(input))), /^\.import-/);
      await fs.copyFile(path.join(media, "tiny.png"), output);
    },
  });
  const loaded = await loadInstalledSkin(imported.themeDir, client);
  assert.equal(loaded.theme.visual.kind, "video");
  assert.equal(loaded.theme.audio.ambient.source, "visual");
  assert.equal(loaded.theme.visual.poster, "media/poster.png");
});

test("normalization accepts portrait or landscape 720p24 and rejects expensive video", () => {
  assert.equal(actions.shouldNormalizeImportedVideo({ family: "video", width: 1280, height: 720, fps: 24 }), false);
  assert.equal(actions.shouldNormalizeImportedVideo({ family: "video", width: 720, height: 1280, fps: 24 }), false);
  assert.equal(actions.shouldNormalizeImportedVideo({ family: "video", width: 1920, height: 1080, fps: 60 }), true);
});

test("failed poster generation leaves no partial theme or change to existing media", async (t) => {
  const root = await fixture(t);
  const existing = await imageTheme(root);
  await assert.rejects(() => actions.importMediaTheme({
    libraryRoot: root, sourcePath: path.join(media, "loop-h264.mp4"),
    createPoster: async () => { throw new Error("encoder unavailable"); },
  }), /encoder unavailable/);
  assert.deepEqual(await fs.readdir(root), [path.basename(existing.themeDir)]);
});

test("successful media import activates the newly validated library entry", async (t) => {
  const root = await fixture(t);
  let active;
  const imported = await actions.importMediaThemeAndActivate({
    libraryRoot: root, sourcePath: path.join(media, "tiny.gif"),
    refreshPayload: async (directory) => { active = (await loadInstalledSkin(directory, client)).theme.id; },
  });
  assert.equal(active, imported.themeId);
});

test("Windows native file picker supports cancellation without hiding process failures", async () => {
  const selected = "C:\\Users\\Example\\中文 ' $ ; image.png";
  assert.equal(await actions.chooseMediaFile({ execute: async () => ({ stdout: JSON.stringify(selected) }) }), selected);
  assert.equal(await actions.chooseMediaFile({ execute: async () => ({ stdout: "null" }) }), null);
  await assert.rejects(() => actions.chooseMediaFile({ execute: async () => { throw new Error("native picker failed"); } }), /native picker failed/);
  await assert.rejects(() => actions.chooseMediaFile({ execute: async () => ({ stdout: "not JSON" }) }), /invalid/i);
});

test("archive and restore move only a validated direct-child theme", async (t) => {
  const root = await fixture(t);
  const imported = await imageTheme(root);
  const archived = await actions.archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir,
    expectedThemeId: imported.themeId });
  await assert.rejects(() => fs.stat(imported.themeDir), { code: "ENOENT" });
  assert.equal(path.dirname(archived.archiveDir), path.join(await fs.realpath(root), ".deleted"));
  await actions.restoreArchivedThemeDirectory({ libraryRoot: root, archiveDir: archived.archiveDir,
    destinationDir: imported.themeDir, expectedThemeId: imported.themeId });
  assert.equal((await loadInstalledSkin(imported.themeDir, client)).theme.id, imported.themeId);
});

test("archive rejects identity changes, outside directories, and archive junctions", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const imported = await imageTheme(root);
  const foreign = await imageTheme(outside);
  await assert.rejects(() => actions.archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir,
    expectedThemeId: "other.identity" }), /identity/i);
  await assert.rejects(() => actions.archiveThemeDirectory({ libraryRoot: root, themeDir: foreign.themeDir,
    expectedThemeId: foreign.themeId }), /direct child/i);
  await fs.symlink(outside, path.join(root, ".deleted"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => actions.archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir,
    expectedThemeId: imported.themeId }), /symbolic|junction|reparse/i);
  assert.ok(await fs.stat(imported.themeDir));
});

test("storage preference survives switching and never falls back when custom disk is gone", async (t) => {
  const root = await fixture(t);
  const fallback = path.join(root, "themes");
  const custom = path.join(root, "custom");
  await fs.mkdir(fallback); await fs.mkdir(custom);
  const preference = storage.themeStoragePreferencePath({ settingsPath: path.join(root, "dynamic-settings.json") });
  assert.equal((await storage.readThemeStoragePreference(preference, fallback)).custom, false);
  await storage.writeThemeStoragePreference(preference, custom);
  assert.equal((await storage.readThemeStoragePreference(preference, fallback)).root, await fs.realpath(custom));
  await fs.rmdir(custom);
  const missing = await storage.readThemeStoragePreference(preference, fallback);
  assert.equal(missing.available, false); assert.equal(missing.root, null); assert.equal(missing.custom, true);
});

test("storage preference rejects a junction instead of reading another location", async (t) => {
  const root = await fixture(t);
  const fallback = path.join(root, "themes"); await fs.mkdir(fallback);
  const foreign = path.join(root, "foreign"); await fs.mkdir(foreign);
  const preference = path.join(root, "theme-storage.json");
  await fs.symlink(foreign, preference, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => storage.readThemeStoragePreference(preference, fallback), /symbolic/i);
});

test("storage migration copies and validates before commit; rollback preserves source", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(source); await fs.mkdir(destination); await videoTheme(source);
  const result = await storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  assert.equal(result.themes.length, 1);
  assert.ok(await fs.stat(path.join(source, "video", "theme.json")));
  assert.equal((await storage.inspectThemeStorage(destination)).themeCount, 1);
  await storage.rollbackThemeLibraryMigration(result);
  await assert.rejects(() => fs.stat(path.join(destination, "video")), { code: "ENOENT" });
  assert.ok(await fs.stat(path.join(source, "video", "theme.json")));
});

test("storage migration commits themes and archives without losing archive contents", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(path.join(source, ".deleted", "old"), { recursive: true }); await fs.mkdir(destination);
  await videoTheme(source);
  await fs.writeFile(path.join(source, ".deleted", "old", "media.mp4"), "preserved");
  const result = await storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  await storage.finalizeThemeLibraryMigration(result);
  assert.equal(await fs.readFile(path.join(destination, ".deleted", "old", "media.mp4"), "utf8"), "preserved");
  await assert.rejects(() => fs.stat(path.join(source, "video")), { code: "ENOENT" });
  assert.equal((await storage.inspectThemeStorage(destination)).themeCount, 1);
});

test("Windows counts and migrates validated legacy presets without rewriting their source format", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  const legacy = path.join(source, "preset-gothic");
  await fs.mkdir(legacy, { recursive: true }); await fs.mkdir(destination);
  const definition = JSON.stringify({ schemaVersion: 1, id: "preset-gothic", name: "Legacy preset", image: "image.png" });
  await fs.writeFile(path.join(legacy, "theme.json"), definition);
  await fs.copyFile(path.join(media, "tiny.png"), path.join(legacy, "image.png"));
  await videoTheme(source);
  assert.equal((await storage.inspectThemeStorage(source)).themeCount, 2);
  const result = await storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  assert.equal(result.themes.length, 2);
  const copied = path.join(destination, "preset-gothic");
  assert.equal(await fs.readFile(path.join(copied, "theme.json"), "utf8"), definition);
  assert.equal((await loadInstalledSkin(copied, client)).sourceApiVersion, 1);
  await storage.finalizeThemeLibraryMigration(result);
  assert.equal((await storage.inspectThemeStorage(destination)).themeCount, 2);
  await assert.rejects(() => fs.stat(legacy), { code: "ENOENT" });
});

test("legacy migration still rejects invalid media before copying or deleting source", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  const legacy = path.join(source, "preset-invalid");
  await fs.mkdir(legacy, { recursive: true }); await fs.mkdir(destination);
  await fs.writeFile(path.join(legacy, "theme.json"), JSON.stringify({ schemaVersion: 1,
    id: "preset-invalid", name: "Invalid preset", image: "image.png" }));
  await fs.writeFile(path.join(legacy, "image.png"), "not an image");
  assert.equal((await storage.inspectThemeStorage(source)).themeCount, 0);
  await assert.rejects(() => storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }));
  assert.equal(await fs.readFile(path.join(legacy, "image.png"), "utf8"), "not an image");
  assert.deepEqual(await fs.readdir(destination), []);
});

test("migration refuses nested roots and leaves conflicting destinations intact", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(source); await fs.mkdir(destination); await videoTheme(source);
  await assert.rejects(() => storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: path.join(source, "nested") }), /must not contain/i);
  await fs.mkdir(path.join(destination, "video"));
  await fs.writeFile(path.join(destination, "video", "untouched.txt"), "existing");
  await assert.rejects(() => storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }), /conflict/i);
  assert.equal(await fs.readFile(path.join(destination, "video", "untouched.txt"), "utf8"), "existing");
  assert.ok(await fs.stat(path.join(source, "video", "theme.json")));
});

test("migration rejects archive junctions before moving any source data", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination"); const outside = path.join(root, "outside");
  await fs.mkdir(source); await fs.mkdir(destination); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(source, ".deleted"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }), /symbolic|junction|reparse/i);
});

test("migration cleanup refuses to delete source after destination data is lost", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(source); await fs.mkdir(destination); await videoTheme(source);
  const result = await storage.migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  await fs.rm(path.join(destination, "video", "media", "loop.mp4"));
  await assert.rejects(() => storage.finalizeThemeLibraryMigration(result), /destination|media|missing|ENOENT/i);
  assert.ok(await fs.stat(path.join(source, "video", "media", "loop.mp4")));
});

test("Windows folder picker returns a selected directory and propagates native failures", async () => {
  assert.equal(await storage.chooseThemeLibraryDirectory({ execute: async () => ({ stdout: JSON.stringify("D:\\My Themes") }) }), "D:\\My Themes");
  assert.equal(await storage.chooseThemeLibraryDirectory({ execute: async () => ({ stdout: "null" }) }), null);
  await assert.rejects(() => storage.chooseThemeLibraryDirectory({ execute: async () => { throw new Error("folder picker failed"); } }), /folder picker failed/);
});

test("ZIP bridge verifies the native importer destination before activating it", async (t) => {
  const root = await fixture(t); const libraryRoot = path.join(root, "themes"); await fs.mkdir(libraryRoot);
  const directory = await videoTheme(libraryRoot);
  const sourcePath = path.join(root, "sample ' $ archive.zip"); await fs.writeFile(sourcePath, "native test boundary");
  const result = await actions.importThemeZip({ libraryRoot, sourcePath, stateRoot: root,
    execute: async () => ({ stdout: JSON.stringify({ Status: "Imported", Path: directory }) }) });
  assert.equal(result.themeId, "test.dynamic-skin"); assert.equal(result.duplicate, false);
  let activated;
  await actions.importMediaThemeAndActivate({ libraryRoot, sourcePath, stateRoot: root,
    importZip: async () => result,
    refreshPayload: async (themeDir) => { activated = (await loadInstalledSkin(themeDir, client)).theme.id; } });
  assert.equal(activated, "test.dynamic-skin");
  const outside = await fixture(t); const foreign = await videoTheme(outside);
  await assert.rejects(() => actions.importThemeZip({ libraryRoot, sourcePath, stateRoot: root,
    execute: async () => ({ stdout: JSON.stringify({ Status: "Imported", Path: foreign }) }) }), /outside/i);
  await assert.rejects(() => actions.importThemeZip({ libraryRoot, sourcePath, stateRoot: root,
    execute: async () => ({ stdout: JSON.stringify({ Status: "Imported", Path: libraryRoot }) }) }), /outside/i);
});

test("small WebP thumbnails remain browser-decodable without requiring an external encoder", async (t) => {
  const root = await fixture(t); const imported = await imageTheme(root, "tiny.webp");
  const loaded = await loadInstalledSkin(imported.themeDir, client);
  const thumbnail = await actions.createThemeThumbnailDataUrl(imported.themeDir, loaded.theme);
  assert.equal(thumbnail, `data:image/webp;base64,${await fs.readFile(path.join(media, "tiny.webp"), "base64")}`);
});

test("GIF cards use a static generated image and reject a thumbnail outside the theme", async (t) => {
  const root = await fixture(t); const imported = await imageTheme(root, "tiny.gif");
  const loaded = await loadInstalledSkin(imported.themeDir, client);
  const staticImage = `data:image/jpeg;base64,${await fs.readFile(path.join(media, "tiny.jpg"), "base64")}`;
  const thumbnail = await actions.createThemeThumbnailDataUrl(imported.themeDir, loaded.theme,
    { execute: async () => ({ stdout: JSON.stringify(staticImage) }) });
  assert.equal(thumbnail, staticImage);
  await assert.rejects(() => actions.createThemeThumbnailDataUrl(imported.themeDir,
    { ...loaded.theme, visual: { kind: "image", asset: "../../outside.png" } }), /inside|relative/i);
});
