import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeV2Package } from "./helpers/theme-fixtures.mjs";

const validator = fileURLToPath(new URL("../../runtime/theme-package-validator.mjs", import.meta.url));

function runValidator(source, stage) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validator, "--source", source, "--stage", stage,
      "--platform", "macos", "--client-version", "1.3.3"]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-v2-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test("accepts an official v2 package with nested declared media", async (t) => {
  const root = await workspace(t); const fixture = await makeV2Package(root, "valid");
  const stage = path.join(root, "stage"); await fs.mkdir(stage);
  const result = await runValidator(fixture.root, stage);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.skinApiVersion, 2); assert.equal(report.themeId, fixture.theme.id);
  assert.ok(report.media.some((entry) => entry.path === fixture.paths.video && entry.codec === "h264"));
});

test("accepts embedded video audio and reports its AAC track", async (t) => {
  const root = await workspace(t); const fixture = await makeV2Package(root, "embedded", { flat: true, embedded: true });
  const stage = path.join(root, "stage"); await fs.mkdir(stage);
  const result = await runValidator(fixture.root, stage);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).media.find((entry) => entry.role === "video").hasAudio, true);
});

test("accepts a simplified v2 package without an official manifest", async (t) => {
  const root = await workspace(t); const fixture = await makeV2Package(root, "simple-v2");
  await fs.rm(path.join(fixture.root, "manifest.json"));
  const stage = path.join(root, "stage"); await fs.mkdir(stage);
  const result = await runValidator(fixture.root, stage);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).format, "simple");
});

test("rejects undeclared, missing, remote, executable, codec-mismatch, and excessive UI assets", async (t) => {
  const root = await workspace(t);
  const cases = [];
  cases.push([await makeV2Package(root, "undeclared", { flat: true, undeclared: true }), /UNDECLARED_FILE/]);
  cases.push([await makeV2Package(root, "missing", { flat: true, mutateFiles: (files, paths) => files.delete(paths.poster) }), /UNDECLARED_ASSET|MISSING_FILE/]);
  cases.push([await makeV2Package(root, "remote", { flat: true, mutateTheme: (theme) => { theme.visual.asset = "https://invalid/video.mp4"; } }), /ASSET_PATH/]);
  cases.push([await makeV2Package(root, "executable", { flat: true, mutateFiles: (files) => files.set("payload.js", Buffer.from("alert(1)")) }), /UNDECLARED_FILE|MEDIA_EXTENSION/]);
  cases.push([await makeV2Package(root, "codec", { flat: true, mutateFiles: (files, paths) => {
    const bytes = Buffer.from(files.get(paths.video)); bytes.write("hvc1", bytes.lastIndexOf(Buffer.from("avc1")), "ascii"); files.set(paths.video, bytes);
  } }), /MEDIA_CODEC/]);
  cases.push([await makeV2Package(root, "ui-count", { flat: true, mutateManifest: (manifest, paths) => {
    const sound = manifest.files.find((entry) => entry.path === paths.ui);
    for (let index = 0; index < 33; index += 1) manifest.files.push({ ...sound, path: `sound-${index}.wav` });
  } }), /ZIP_LIMIT|UI|UNDECLARED_FILE/]);
  for (const [fixture, expected] of cases) {
    const stage = path.join(root, `stage-${path.basename(fixture.root)}`); await fs.mkdir(stage);
    const result = await runValidator(fixture.root, stage);
    assert.notEqual(result.code, 0, fixture.root); assert.match(result.stderr, expected); assert.deepEqual(await fs.readdir(stage), []);
  }
});

test("rejects every declared v2 file-size and entry-count boundary before reading payloads", async (t) => {
  const root = await workspace(t);
  const mutations = [
    ["text-limit", (manifest) => { manifest.files.find((entry) => entry.path === "theme.css").bytes = 262_145; }],
    ["image-limit", (manifest) => { manifest.files.find((entry) => entry.mediaType === "image/webp").bytes = 16 * 1024 * 1024 + 1; }],
    ["video-limit", (manifest) => { manifest.files.find((entry) => entry.mediaType === "video/mp4").bytes = 96 * 1024 * 1024 + 1; }],
    ["audio-limit", (manifest) => { manifest.files.find((entry) => entry.mediaType === "audio/mp4").bytes = 32 * 1024 * 1024 + 1; }],
    ["entry-limit", (manifest) => {
      const sound = manifest.files.find((entry) => entry.mediaType === "audio/wav");
      while (manifest.files.length < 64) manifest.files.push({ ...sound, path: `extra-${manifest.files.length}.wav` });
    }],
  ];
  for (const [name, mutateManifest] of mutations) {
    const fixture = await makeV2Package(root, name, { flat: true, mutateManifest });
    const stage = path.join(root, `stage-${name}`); await fs.mkdir(stage);
    const result = await runValidator(fixture.root, stage);
    assert.notEqual(result.code, 0, name); assert.match(result.stderr, /ZIP_LIMIT/); assert.deepEqual(await fs.readdir(stage), []);
  }
});
