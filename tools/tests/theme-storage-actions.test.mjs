import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeV2Package } from "./helpers/theme-fixtures.mjs";

import {
  finalizeThemeLibraryMigration,
  inspectThemeStorage,
  migrateThemeLibrary,
  readThemeStoragePreference,
  rollbackThemeLibraryMigration,
  writeThemeStoragePreference,
} from "../../macos/scripts/theme-storage-actions.mjs";

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("storage preference uses the fallback until a custom library is saved", async (t) => {
  const root = await temporaryRoot(t);
  const fallback = path.join(root, "fallback");
  const custom = path.join(root, "custom");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(fallback);
  await fs.mkdir(custom);
  assert.deepEqual(await readThemeStoragePreference(preference, fallback), {
    root: await fs.realpath(fallback), configuredRoot: await fs.realpath(fallback),
    available: true, custom: false,
  });
  await writeThemeStoragePreference(preference, custom);
  assert.deepEqual(await readThemeStoragePreference(preference, fallback), {
    root: await fs.realpath(custom), configuredRoot: await fs.realpath(custom),
    available: true, custom: true,
  });
});

test("an unavailable external library stays unavailable instead of falling back", async (t) => {
  const root = await temporaryRoot(t);
  const fallback = path.join(root, "fallback");
  const missing = path.join(root, "External", "DreamSkin");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(fallback);
  await fs.writeFile(preference, `${JSON.stringify({ schemaVersion: 1, libraryRoot: missing })}\n`);
  assert.deepEqual(await readThemeStoragePreference(preference, fallback), {
    root: null, configuredRoot: missing, available: false, custom: true,
  });
});

test("migration validates copied themes before old copies are removed", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await makeV2Package(source, "video", { mutateTheme(theme) {
    theme.id = "com.mars.dynamic-video";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.dynamic-video"; } });
  await fs.rm(path.join(source, "video", "manifest.json"));
  const result = await migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination });
  assert.equal(result.themes.length, 1);
  assert.equal(result.themes[0].themeId, "com.mars.dynamic-video");
  assert.equal(result.themes[0].destination, await fs.realpath(path.join(destination, "video")));
  await assert.rejects(() => fs.stat(path.join(source, "video")), { code: "ENOENT" });
  assert.equal((await fs.stat(path.join(destination, "video", "theme.json"))).isFile(), true);
  const storage = await inspectThemeStorage(destination);
  assert.equal(storage.available, true);
  assert.equal(storage.themeCount, 1);
  assert.equal(storage.bytes > 0, true);
});

test("migration refuses nested destinations and conflicting theme identities", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await makeV2Package(source, "video", { mutateTheme(theme) {
    theme.id = "com.mars.dynamic-video";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.dynamic-video"; } });
  await fs.rm(path.join(source, "video", "manifest.json"));
  await assert.rejects(
    () => migrateThemeLibrary({ sourceRoot: source, destinationRoot: path.join(source, "nested") }),
    /must not contain/i,
  );
  await makeV2Package(destination, "video", { mutateTheme(theme) {
    theme.id = "com.mars.conflicting-theme";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.conflicting-theme"; } });
  await fs.rm(path.join(destination, "video", "manifest.json"));
  await assert.rejects(
    () => migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }),
    /conflict/i,
  );
  assert.equal((await fs.stat(path.join(source, "video", "theme.json"))).isFile(), true);
});

test("deferred migration can be rolled back before preference commit", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await makeV2Package(source, "video", { mutateTheme(theme) {
    theme.id = "com.mars.rollback-video";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.rollback-video"; } });
  await fs.rm(path.join(source, "video", "manifest.json"));
  const result = await migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination,
    removeSource: false });
  await rollbackThemeLibraryMigration(result);
  assert.equal((await fs.stat(path.join(source, "video", "theme.json"))).isFile(), true);
  await assert.rejects(() => fs.stat(path.join(destination, "video")), { code: "ENOENT" });
});

test("migration carries archived deleted themes and only removes them after commit", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(path.join(source, ".deleted", "old-theme"), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, ".deleted", "old-theme", "large-video.mp4"), "archived-media");
  const result = await migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination,
    removeSource: false });
  assert.equal(await fs.readFile(path.join(destination, ".deleted", "old-theme", "large-video.mp4"), "utf8"),
    "archived-media");
  assert.equal((await fs.stat(path.join(source, ".deleted", "old-theme", "large-video.mp4"))).isFile(), true);
  await finalizeThemeLibraryMigration(result);
  await assert.rejects(() => fs.stat(path.join(source, ".deleted", "old-theme")), { code: "ENOENT" });
});
