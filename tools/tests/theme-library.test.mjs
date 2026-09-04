import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as injector from "../../macos/scripts/injector.mjs";
import { makeV2Package } from "./helpers/theme-fixtures.mjs";

const { scanThemeLibrary } = injector;

test("trusted theme library exposes only validated direct children and keeps paths host-side", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await makeV2Package(root, "starlight", { mutateTheme(theme) {
    theme.id = "com.mars.starlight-in-eyes"; theme.name = "眼里的星光";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.starlight-in-eyes"; } });
  await makeV2Package(root, "space", { mutateTheme(theme) {
    theme.id = "com.mars.space-roamer"; theme.name = "傲游太空";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.space-roamer"; } });
  await Promise.all(["starlight", "space"].map((name) => fs.rm(path.join(root, name, "manifest.json"))));
  await fs.mkdir(path.join(root, "broken"));
  await fs.writeFile(path.join(root, "broken", "theme.json"), "{}\n");

  const scanned = await scanThemeLibrary(root, {
    createThumbnail: async (_themeDir, theme) => `data:image/jpeg;base64,${Buffer.from(theme.id).toString("base64")}`,
  });
  assert.deepEqual(scanned.themeCatalog, [
    { id: "com.mars.space-roamer", name: "傲游太空", kind: "video", hasAudio: true,
      thumbnail: `data:image/jpeg;base64,${Buffer.from("com.mars.space-roamer").toString("base64")}` },
    { id: "com.mars.starlight-in-eyes", name: "眼里的星光", kind: "video", hasAudio: true,
      thumbnail: `data:image/jpeg;base64,${Buffer.from("com.mars.starlight-in-eyes").toString("base64")}` },
  ]);
  assert.equal(scanned.themeDirectories.get("com.mars.space-roamer"), await fs.realpath(path.join(root, "space")));
  assert.equal(JSON.stringify(scanned.themeCatalog).includes(root), false);
  assert.equal(scanned.rejected.length, 1);
});

test("theme library refuses a symbolic-link root", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-library-link-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const real = path.join(parent, "real");
  const link = path.join(parent, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link);
  await assert.rejects(() => scanThemeLibrary(link), /symbolic link/i);
});

test("one-shot payload preparation includes the requested theme library", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-verify-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const selected = await makeV2Package(root, "starlight", { mutateTheme(theme) {
    theme.id = "com.mars.starlight-in-eyes"; theme.name = "眼里的星光";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.starlight-in-eyes"; } });
  await makeV2Package(root, "space", { mutateTheme(theme) {
    theme.id = "com.mars.space-roamer"; theme.name = "傲游太空";
  }, mutateManifest(manifest) { manifest.themeId = "com.mars.space-roamer"; } });
  await Promise.all(["starlight", "space"].map((name) => fs.rm(path.join(root, name, "manifest.json"))));

  assert.equal(typeof injector.loadPayloadForOptions, "function",
    "The one-shot verifier needs the same library-aware payload preparation as the watcher.");
  const loaded = await injector.loadPayloadForOptions({ themeDir: selected.root, themeLibrary: root });
  assert.deepEqual(loaded.dynamicRenderer.themeCatalog.map(({ thumbnail, ...entry }) => ({
    ...entry, thumbnailType: thumbnail?.slice(0, thumbnail.indexOf(",")),
  })), [
    { id: "com.mars.space-roamer", name: "傲游太空", kind: "video", hasAudio: true,
      thumbnailType: "data:image/jpeg;base64" },
    { id: "com.mars.starlight-in-eyes", name: "眼里的星光", kind: "video", hasAudio: true,
      thumbnailType: "data:image/jpeg;base64" },
  ]);
  assert.equal(JSON.stringify(loaded.dynamicRenderer.themeCatalog).includes(root), false);
});
