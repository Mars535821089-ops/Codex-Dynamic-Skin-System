import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as actions from "../../macos/scripts/theme-library-actions.mjs";
import { scanThemeLibrary } from "../../macos/scripts/injector.mjs";

const {
  archiveThemeDirectory,
  importMediaTheme,
  restoreArchivedThemeDirectory,
  shouldNormalizeImportedVideo,
} = actions;

const mediaRoot = fileURLToPath(new URL("fixtures/media/", import.meta.url));
const actionsSource = await fs.readFile(
  fileURLToPath(new URL("../../macos/scripts/theme-library-actions.mjs", import.meta.url)),
  "utf8",
);

test("native media chooser activates before presenting the file dialog", () => {
  assert.match(
    actionsSource,
    /export async function chooseMediaFile\(\)[\s\S]*?const script = \[[\s\S]*?"with timeout of 600 seconds",[\s\S]*?"tell application \\"Finder\\"",\s*"activate",\s*"set selectedFile to choose file/,
  );
});

test("oversized or high-frame-rate video is normalized before becoming a live theme", () => {
  assert.equal(shouldNormalizeImportedVideo({ family: "video", width: 3440, height: 1440, fps: 60 }), true);
  assert.equal(shouldNormalizeImportedVideo({ family: "video", width: 1920, height: 1080, fps: 30 }), true);
  assert.equal(shouldNormalizeImportedVideo({ family: "video", width: 1280, height: 720, fps: 24 }), false);
  assert.equal(shouldNormalizeImportedVideo({ family: "video", width: 720, height: 1280, fps: 24 }), false);
  assert.equal(shouldNormalizeImportedVideo({ family: "image", width: 3440, height: 1440 }), false);
});

test("video import publishes the normalized file and revalidates its playback limits", async (t) => {
  const root = await tempLibrary(t);
  const source = path.join(mediaRoot, "loop-h264.mp4");
  const posterFixture = path.join(mediaRoot, "tiny.png");
  const imported = await importMediaTheme({
    libraryRoot: root,
    sourcePath: source,
    themeName: "Normalized loop",
    inspectMedia: async (filePath, options) => {
      if (path.resolve(filePath) === path.resolve(source)) {
        return { family: "video", container: "mp4", mime: "video/mp4", sizeBytes: 10,
          width: 3440, height: 1440, fps: 60, hasAudio: false };
      }
      return options.role === "poster"
        ? { family: "image", container: "png", mime: "image/png", sizeBytes: 10, width: 1, height: 1 }
        : { family: "video", container: "mp4", mime: "video/mp4", sizeBytes: 10,
          width: 1280, height: 536, fps: 24, hasAudio: false };
    },
    optimizeVideo: async (_input, output) => fs.copyFile(source, output),
    createPoster: async (_video, poster) => fs.copyFile(posterFixture, poster),
  });

  assert.equal(imported.optimized, true);
  assert.equal(imported.media.width, 1280);
  assert.equal(imported.media.height, 536);
  assert.equal(imported.media.fps, 24);
  assert.equal(await fs.readFile(path.join(imported.themeDir, "media", "visual.mp4"), "hex"),
    await fs.readFile(source, "hex"));
});

async function tempLibrary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-actions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("image import commits one validated direct-child theme atomically", async (t) => {
  const root = await tempLibrary(t);
  const source = path.join(mediaRoot, "tiny.jpg");
  const imported = await importMediaTheme({ libraryRoot: root, sourcePath: source, themeName: "My / Image" });

  assert.match(imported.themeId, /^com\.mars\.local\.media-[0-9a-f]{16}$/);
  assert.equal(path.dirname(imported.themeDir), await fs.realpath(root));
  const theme = JSON.parse(await fs.readFile(path.join(imported.themeDir, "theme.json"), "utf8"));
  assert.equal(theme.name, "My Image");
  assert.deepEqual(theme.visual, { kind: "image", asset: "media/visual.jpg", fit: "adaptive", opacity: 1 });
  assert.deepEqual(theme.audio.ambient, { source: "none" });
  const contentManifest = JSON.parse(
    await fs.readFile(path.join(imported.themeDir, "content-manifest.json"), "utf8"),
  );
  assert.match(contentManifest.versionId, /^skin_[0-9a-f]{64}$/);
  assert.deepEqual(contentManifest.files.map((entry) => entry.path), ["media/visual.jpg", "theme.json"]);
  assert.equal((await scanThemeLibrary(root)).themeCatalog.length, 1);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith(".import-")), false);
});

test("video import generates a validated poster and preserves embedded-audio intent", async (t) => {
  const root = await tempLibrary(t);
  const source = path.join(mediaRoot, "loop-h264.mp4");
  const posterFixture = path.join(mediaRoot, "tiny.png");
  let posterSource = null;
  const imported = await importMediaTheme({
    libraryRoot: root,
    sourcePath: source,
    themeName: "Loop",
    createPoster: async (video, poster) => {
      posterSource = video;
      await fs.copyFile(posterFixture, poster);
    },
  });

  assert.equal(path.basename(posterSource), "visual.mp4");
  assert.match(path.basename(path.dirname(path.dirname(posterSource))), /^\.import-/,
    "poster generation must read the frozen staging copy, not the mutable source path");

  const theme = JSON.parse(await fs.readFile(path.join(imported.themeDir, "theme.json"), "utf8"));
  assert.deepEqual(theme.visual, {
    kind: "video", asset: "media/visual.mp4", poster: "media/poster.png",
    fit: "adaptive", opacity: 1, overscan: 1.08, loop: true,
  });
  assert.deepEqual(theme.audio.ambient, { source: "visual", loop: true, volume: 0.7, analyze: true });
  assert.equal((await scanThemeLibrary(root)).rejected.length, 0);
});

test("media import activates the newly published theme so it is immediately visible", async (t) => {
  const root = await tempLibrary(t);
  const existing = await importMediaTheme({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "tiny.png"),
    themeName: "Existing",
  });
  let activeThemeId = JSON.parse(
    await fs.readFile(path.join(existing.themeDir, "theme.json"), "utf8"),
  ).id;

  assert.equal(typeof actions.importMediaThemeAndActivate, "function");
  const imported = await actions.importMediaThemeAndActivate({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "loop-h264.mp4"),
    themeName: "New video",
    createPoster: async (_video, poster) => fs.copyFile(path.join(mediaRoot, "tiny.png"), poster),
    refreshPayload: async (themeDir) => {
      const theme = JSON.parse(await fs.readFile(path.join(themeDir, "theme.json"), "utf8"));
      activeThemeId = theme.id;
    },
  });

  assert.equal(activeThemeId, imported.themeId);
  assert.notEqual(activeThemeId, existing.themeId);
  assert.equal((await scanThemeLibrary(root)).themeCatalog.some(
    (entry) => entry.id === imported.themeId && entry.name === "New video",
  ), true);
});

test("GIF import commits an image visual without replacing animation with a poster", async (t) => {
  const root = await tempLibrary(t);
  const imported = await importMediaTheme({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "tiny.gif"),
    themeName: "Animated GIF",
  });
  const theme = JSON.parse(await fs.readFile(path.join(imported.themeDir, "theme.json"), "utf8"));

  assert.deepEqual(theme.visual, {
    kind: "image", asset: "media/visual.gif", fit: "adaptive", opacity: 1,
  });
  assert.equal(imported.media.container, "gif");
  assert.equal((await scanThemeLibrary(root)).rejected.length, 0);
});

test("unsupported media leaves no partial theme behind", async (t) => {
  const root = await tempLibrary(t);
  const unsupported = path.join(root, "sample.heic");
  await fs.writeFile(unsupported, "not-a-supported-import");
  await assert.rejects(
    () => importMediaTheme({ libraryRoot: root, sourcePath: unsupported }),
    /unsupported/i,
  );
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith(".import-")), false);
});

test("theme deletion archives the exact validated direct child and removes it from catalog", async (t) => {
  const root = await tempLibrary(t);
  const imported = await importMediaTheme({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "tiny.png"),
    themeName: "Delete me",
  });
  const archived = await archiveThemeDirectory({
    libraryRoot: root,
    themeDir: imported.themeDir,
    expectedThemeId: imported.themeId,
    timestamp: 1_787_837_000_000,
  });

  await assert.rejects(() => fs.stat(imported.themeDir), { code: "ENOENT" });
  assert.equal(path.dirname(archived.archiveDir), path.join(await fs.realpath(root), ".deleted"));
  assert.equal(JSON.parse(await fs.readFile(path.join(archived.archiveDir, "theme.json"), "utf8")).id, imported.themeId);
  assert.deepEqual((await scanThemeLibrary(root)).themeCatalog, []);
});

test("an archived theme can be transactionally restored after a failed catalog refresh", async (t) => {
  const root = await tempLibrary(t);
  const imported = await importMediaTheme({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "tiny.png"),
    themeName: "Restore me",
  });
  const archived = await archiveThemeDirectory({
    libraryRoot: root,
    themeDir: imported.themeDir,
    expectedThemeId: imported.themeId,
  });

  await restoreArchivedThemeDirectory({
    libraryRoot: root,
    archiveDir: archived.archiveDir,
    destinationDir: imported.themeDir,
    expectedThemeId: imported.themeId,
  });

  assert.equal(JSON.parse(await fs.readFile(path.join(imported.themeDir, "theme.json"), "utf8")).id,
    imported.themeId);
  await assert.rejects(() => fs.stat(archived.archiveDir), { code: "ENOENT" });
});

test("theme deletion reuses an existing archive directory", async (t) => {
  const root = await tempLibrary(t);
  const first = await importMediaTheme({
    libraryRoot: root,
    sourcePath: path.join(mediaRoot, "tiny.png"),
    themeName: "First",
  });
  const secondSource = path.join(root, "second.jpg");
  await fs.copyFile(path.join(mediaRoot, "tiny.jpg"), secondSource);
  const second = await importMediaTheme({
    libraryRoot: root,
    sourcePath: secondSource,
    themeName: "Second",
  });

  const firstArchive = await archiveThemeDirectory({
    libraryRoot: root,
    themeDir: first.themeDir,
    expectedThemeId: first.themeId,
    timestamp: 1_787_837_000_001,
  });
  const secondArchive = await archiveThemeDirectory({
    libraryRoot: root,
    themeDir: second.themeDir,
    expectedThemeId: second.themeId,
    timestamp: 1_787_837_000_002,
  });

  assert.equal(path.dirname(firstArchive.archiveDir), path.dirname(secondArchive.archiveDir));
  assert.equal((await fs.readdir(path.dirname(firstArchive.archiveDir))).length, 2);
});

test("theme deletion refuses paths outside the selected library", async (t) => {
  const root = await tempLibrary(t);
  const outside = await tempLibrary(t);
  const imported = await importMediaTheme({ libraryRoot: outside, sourcePath: path.join(mediaRoot, "tiny.png") });
  await assert.rejects(
    () => archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir, expectedThemeId: imported.themeId }),
    /direct child/i,
  );
});

test("theme deletion and rollback reject a replaced archive directory link", async (t) => {
  const root = await tempLibrary(t); const outside = await tempLibrary(t);
  const imported = await importMediaTheme({ libraryRoot: root, sourcePath: path.join(mediaRoot, "tiny.png") });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(root, ".deleted"), linkType);
  await assert.rejects(() => archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir,
    expectedThemeId: imported.themeId }), /symbolic|junction/i);
  assert.ok(await fs.stat(imported.themeDir));
  await fs.unlink(path.join(root, ".deleted"));
  const archived = await archiveThemeDirectory({ libraryRoot: root, themeDir: imported.themeDir,
    expectedThemeId: imported.themeId });
  const movedArchive = path.join(outside, "archive");
  await fs.rename(path.join(root, ".deleted"), movedArchive);
  await fs.symlink(movedArchive, path.join(root, ".deleted"), linkType);
  await assert.rejects(() => restoreArchivedThemeDirectory({ libraryRoot: root,
    archiveDir: archived.archiveDir, destinationDir: imported.themeDir,
    expectedThemeId: imported.themeId }), /symbolic|junction/i);
  assert.ok(await fs.stat(path.join(movedArchive, path.basename(archived.archiveDir))));
});
