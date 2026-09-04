import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildThemePackage } from "../create-theme-package.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const mediaRoot = path.join(here, "fixtures/media");
const validatorPath = path.join(repoRoot, "runtime/theme-package-validator.mjs");

function readStoredZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedBytes = buffer.readUInt32LE(offset + 18);
    const uncompressedBytes = buffer.readUInt32LE(offset + 22);
    const nameBytes = buffer.readUInt16LE(offset + 26);
    const extraBytes = buffer.readUInt16LE(offset + 28);
    assert.equal(flags, 0x0800, "ZIP entries must use only the UTF-8 flag");
    assert.equal(method, 0, "theme-package builder must produce stored entries");
    assert.equal(compressedBytes, uncompressedBytes);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameBytes + extraBytes;
    const name = buffer.subarray(nameStart, nameStart + nameBytes).toString("utf8");
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedBytes));
    offset = dataStart + compressedBytes;
  }
  return entries;
}

async function validateArchive(archivePath, platform = "macos") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-validate-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  await fs.mkdir(source);
  await fs.mkdir(stage);
  const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", archivePath, source], { encoding: "utf8" });
  assert.equal(unzip.status, 0, unzip.stderr || unzip.stdout);
  const validation = spawnSync(process.execPath, [
    validatorPath,
    "--source", source,
    "--stage", stage,
    "--platform", platform,
    "--client-version", "2.0.0",
  ], { encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  return JSON.parse(validation.stdout);
}

test("builds a valid embedded-audio video theme with poster and UI sound", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "ocean.codexskin");

  await buildThemePackage({
    id: "mars.ocean",
    name: "Ocean",
    video: path.join(mediaRoot, "loop-h264.mp4"),
    poster: path.join(mediaRoot, "tiny.webp"),
    ambientFromVideo: true,
    ui: { taskCompleted: path.join(mediaRoot, "tone-pcm.wav") },
    output,
  });

  const entries = readStoredZip(await fs.readFile(output));
  assert.deepEqual([...entries.keys()], [
    "audio/ui/task-completed.wav",
    "manifest.json",
    "media/poster.webp",
    "media/visual.mp4",
    "theme.json",
  ]);
  const theme = JSON.parse(entries.get("theme.json"));
  assert.equal(theme.visual.loop, true);
  assert.deepEqual(theme.audio.ambient, {
    source: "visual", loop: true, volume: 0.7, analyze: true,
  });
  assert.deepEqual(theme.audio.ui.events, {
    taskCompleted: "audio/ui/task-completed.wav",
  });
  const validated = await validateArchive(output);
  assert.equal(validated.themeId, "mars.ocean");
});

test("supports separate ambient audio and an intentionally muted video", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-audio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const separate = path.join(root, "separate.codexskin");
  const muted = path.join(root, "muted.codexskin");

  await buildThemePackage({
    id: "mars.separate", name: "Separate",
    video: path.join(mediaRoot, "loop-h264.mp4"),
    ambient: path.join(mediaRoot, "tone-aac.m4a"), output: separate,
  });
  await buildThemePackage({
    id: "mars.muted", name: "Muted",
    video: path.join(mediaRoot, "loop-h264.mp4"), muteVideo: true, output: muted,
  });

  const separateEntries = readStoredZip(await fs.readFile(separate));
  assert.deepEqual(JSON.parse(separateEntries.get("theme.json")).audio.ambient, {
    source: "asset", asset: "audio/ambient.m4a", loop: true, volume: 0.7, analyze: true,
  });
  assert.equal(separateEntries.has("audio/ambient.m4a"), true);
  const mutedEntries = readStoredZip(await fs.readFile(muted));
  assert.deepEqual(JSON.parse(mutedEntries.get("theme.json")).audio.ambient, {
    source: "none", loop: true, volume: 0.7, analyze: false,
  });
  await validateArchive(separate, "windows");
  await validateArchive(muted);
});

test("builds a declarative first-party voxel theme without executable payloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-voxel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "voxel.codexskin");

  await buildThemePackage({
    id: "mars.voxel-acceptance",
    name: "Voxel acceptance",
    voxelField: true,
    fallbackVideo: path.join(mediaRoot, "loop-h264.mp4"),
    poster: path.join(mediaRoot, "tiny.webp"),
    ambientFromVideo: true,
    ui: {
      taskCompleted: path.join(mediaRoot, "tone-pcm.wav"),
      approvalRequested: path.join(mediaRoot, "tone-pcm.wav"),
      taskFailed: path.join(mediaRoot, "tone-pcm.wav"),
    },
    output,
  });

  const entries = readStoredZip(await fs.readFile(output));
  assert.deepEqual([...entries.keys()], [
    "audio/ui/approval-requested.wav",
    "audio/ui/task-completed.wav",
    "audio/ui/task-failed.wav",
    "manifest.json",
    "media/fallback.mp4",
    "media/poster.webp",
    "theme.json",
  ]);
  assert.equal([...entries.keys()].some((name) => /\.(?:js|mjs|html|wasm|glsl)$/i.test(name)), false);
  const theme = JSON.parse(entries.get("theme.json"));
  assert.deepEqual(theme.visual, {
    kind: "builtin-effect",
    effect: "voxel-field",
    fallback: { video: "media/fallback.mp4", poster: "media/poster.webp" },
    fit: "adaptive",
    opacity: 1,
  });
  assert.equal(theme.effect.id, "voxel-field");
  assert.equal(theme.effect.source, "ambient");
  assert.deepEqual(theme.capabilities, ["animated-background", "sound-pack", "builtin-effect"]);
  const validated = await validateArchive(output, "windows");
  assert.equal(validated.themeId, "mars.voxel-acceptance");
});

test("produces byte-identical archives and refuses overwrite unless forced", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-repeat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first.codexskin");
  const second = path.join(root, "second.codexskin");
  const options = {
    id: "mars.repeat", name: "Repeat",
    video: path.join(mediaRoot, "loop-h264.mp4"), muteVideo: true,
  };

  await buildThemePackage({ ...options, output: first });
  await buildThemePackage({ ...options, output: second });
  assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
  await assert.rejects(
    buildThemePackage({ ...options, output: first }),
    /already exists/i,
  );
  await buildThemePackage({ ...options, output: first, force: true });
});

test("rejects conflicting ambient modes before writing an archive", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theme-package-conflict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "bad.codexskin");
  await assert.rejects(buildThemePackage({
    id: "mars.bad", name: "Bad",
    video: path.join(mediaRoot, "loop-h264.mp4"),
    ambientFromVideo: true,
    ambient: path.join(mediaRoot, "tone-aac.m4a"),
    output,
  }), /mutually exclusive/i);
  await assert.rejects(fs.access(output));
});
