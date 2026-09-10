import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeV2Package } from "./helpers/theme-fixtures.mjs";
import * as storageActions from "../../macos/scripts/theme-storage-actions.mjs";

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

test("transient storage classification excludes validation and programming errors", () => {
  assert.equal(typeof storageActions.isTransientThemeStorageError, "function");
  for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ESTALE", "EIO"]) {
    assert.equal(storageActions.isTransientThemeStorageError(Object.assign(new Error(code), { code })), true);
  }
  for (const error of [null, undefined, new TypeError("invalid path"), new Error("symbolic link"),
    { code: "ELOOP" }, { code: "ERR_INVALID_ARG_TYPE" }]) {
    assert.equal(storageActions.isTransientThemeStorageError(error), false);
  }
});

test("custom library read failures report unavailable without changing the saved preference", async (t) => {
  for (const method of ["lstat", "realpath", "readdir"]) {
    for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ESTALE", "EIO"]) {
      await t.test(`${method}: ${code}`, async (t) => {
        const root = await fs.realpath(await temporaryRoot(t));
        const custom = path.join(root, "external");
        const fallback = path.join(root, "fallback");
        const preference = path.join(root, "theme-storage.json");
        await fs.mkdir(custom);
        await fs.mkdir(fallback);
        await writeThemeStoragePreference(preference, custom);
        const savedPreference = await fs.readFile(preference, "utf8");
        const original = fs[method].bind(fs);
        t.mock.method(fs, method, async (target, ...args) => {
          if (target === custom) throw Object.assign(new Error(`${code}: ${method}`), { code });
          return original(target, ...args);
        });
        assert.deepEqual(await readThemeStoragePreference(preference, fallback), {
          root: null, configuredRoot: custom, available: false, custom: true,
        });
        assert.equal(await fs.readFile(preference, "utf8"), savedPreference);
        assert.deepEqual(await fs.readdir(fallback), []);
      });
    }
  }
});

test("a custom library becomes available when its directory can be scanned again", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  const custom = path.join(root, "external");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(custom);
  await writeThemeStoragePreference(preference, custom);
  let denied = true;
  const original = fs.readdir.bind(fs);
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === custom && denied) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    return original(target, ...args);
  });
  assert.deepEqual(await readThemeStoragePreference(preference, root), {
    root: null, configuredRoot: custom, available: false, custom: true,
  });
  denied = false;
  assert.deepEqual(await readThemeStoragePreference(preference, root), {
    root: custom, configuredRoot: custom, available: true, custom: true,
  });
});

test("configured library path stays stable when a canonical directory becomes unavailable", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  const actualParent = path.join(root, "actual");
  const aliasParent = path.join(root, "alias");
  const canonicalLibrary = path.join(actualParent, "library");
  const configuredLibrary = path.join(aliasParent, "library");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(canonicalLibrary, { recursive: true });
  await fs.symlink(actualParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(preference, JSON.stringify({ schemaVersion: 1, libraryRoot: configuredLibrary }));
  let denied = false;
  const original = fs.readdir.bind(fs);
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === canonicalLibrary && denied) {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    }
    return original(target, ...args);
  });
  const available = await readThemeStoragePreference(preference, root);
  denied = true;
  const unavailable = await readThemeStoragePreference(preference, root);
  assert.deepEqual(available, {
    root: canonicalLibrary, configuredRoot: configuredLibrary, available: true, custom: true,
  });
  assert.deepEqual(unavailable, {
    root: null, configuredRoot: configuredLibrary, available: false, custom: true,
  });
});

test("storage inspection discards partial results when a directory or file becomes unreadable", async (t) => {
  for (const [method, targetKind] of [["lstat", "root"], ["realpath", "root"],
    ["readdir", "root"], ["readdir", "nested"], ["stat", "file"]]) {
    for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ESTALE", "EIO"]) {
      await t.test(`${method} ${targetKind}: ${code}`, async (t) => {
        const root = await fs.realpath(await temporaryRoot(t));
        const library = path.join(root, "external");
        const nested = path.join(library, ".archive");
        const file = path.join(nested, "media.mp4");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(file, "media");
        const targetPath = targetKind === "root" ? library : targetKind === "nested" ? nested : file;
        const original = fs[method].bind(fs);
        t.mock.method(fs, method, async (target, ...args) => {
          if (target === targetPath) throw Object.assign(new Error(`${code}: ${method}`), { code });
          return original(target, ...args);
        });
        assert.deepEqual(await inspectThemeStorage(library), {
          path: library, available: false, bytes: 0, themeCount: 0,
        });
      });
    }
  }
});

test("storage reads keep invalid preferences, linked roots, and non-directories fail-closed", async (t) => {
  const root = await temporaryRoot(t);
  const preference = path.join(root, "theme-storage.json");
  await fs.writeFile(preference, "{");
  await assert.rejects(() => readThemeStoragePreference(preference, root), SyntaxError);
  await fs.writeFile(preference, JSON.stringify({ schemaVersion: 1, libraryRoot: "relative" }));
  await assert.rejects(() => readThemeStoragePreference(preference, root), /invalid/);
  const file = path.join(root, "file");
  const link = path.join(root, "linked");
  await fs.writeFile(file, "not a directory");
  await fs.symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  for (const [libraryRoot, message] of [[file, /must be a directory/], [link, /symbolic link/]]) {
    await fs.writeFile(preference, JSON.stringify({ schemaVersion: 1, libraryRoot }));
    await assert.rejects(() => readThemeStoragePreference(preference, root), message);
    await assert.rejects(() => inspectThemeStorage(libraryRoot), message);
  }
});

test("unexpected filesystem errors propagate from preference reads and storage scans", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  const library = path.join(root, "library");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(library);
  await writeThemeStoragePreference(preference, library);
  const failure = Object.assign(new TypeError("unexpected filesystem failure"), { code: "ERR_INVALID_ARG_TYPE" });
  const original = fs.readdir.bind(fs);
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === library) throw failure;
    return original(target, ...args);
  });
  await assert.rejects(() => readThemeStoragePreference(preference, root), (error) => error === failure);
  await assert.rejects(() => inspectThemeStorage(library), (error) => error === failure);
});

test("storage write and migration permissions remain strict", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const preference = path.join(root, "theme-storage.json");
  await fs.mkdir(path.join(source, ".deleted"), { recursive: true });
  await fs.mkdir(destination);
  const original = fs.lstat.bind(fs);
  const failure = Object.assign(new Error("permission denied"), { code: "EPERM" });
  t.mock.method(fs, "lstat", async (target, ...args) => {
    if (target === path.join(source, ".deleted")) throw failure;
    return original(target, ...args);
  });
  await assert.rejects(() => writeThemeStoragePreference(preference, path.join(source, ".deleted")),
    (error) => error === failure);
  await assert.rejects(() => migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }),
    (error) => error === failure);
  await assert.rejects(() => fs.stat(preference), { code: "ENOENT" });
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

test("migration cleanup retains source when destination media is missing", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(source); await fs.mkdir(destination);
  const fixture = await makeV2Package(source, "video");
  await fs.rm(path.join(fixture.root, "manifest.json"));
  const result = await migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  await fs.rm(path.join(destination, "video", "media", "loop.mp4"));
  await assert.rejects(() => finalizeThemeLibraryMigration(result), /destination|media|missing|ENOENT/i);
  assert.ok(await fs.stat(path.join(source, "video", "media", "loop.mp4")));
});

test("migration cleanup retains archived source when copied archive changes", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination");
  await fs.mkdir(path.join(source, ".deleted", "old"), { recursive: true }); await fs.mkdir(destination);
  await fs.writeFile(path.join(source, ".deleted", "old", "media.mp4"), "original");
  const result = await migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination, removeSource: false });
  await fs.writeFile(path.join(destination, ".deleted", "old", "media.mp4"), "changed");
  await assert.rejects(() => finalizeThemeLibraryMigration(result), /destination.*changed/i);
  assert.equal(await fs.readFile(path.join(source, ".deleted", "old", "media.mp4"), "utf8"), "original");
});

test("migration refuses linked archive roots in either library", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "source"); const destination = path.join(root, "destination"); const outside = path.join(root, "outside");
  await fs.mkdir(source); await fs.mkdir(destination); await fs.mkdir(outside);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(source, ".deleted"), linkType);
  await assert.rejects(() => migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }), /symbolic/i);
  await fs.unlink(path.join(source, ".deleted"));
  await fs.symlink(outside, path.join(destination, ".deleted"), linkType);
  await assert.rejects(() => migrateThemeLibrary({ sourceRoot: source, destinationRoot: destination }), /symbolic/i);
});
