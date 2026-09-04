import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mediaModuleUrl = new URL("../../runtime/dynamic/media-signatures.mjs", import.meta.url);
const fixtureRoot = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
let mediaModule = null;
try { mediaModule = await import(mediaModuleUrl); } catch {}

function parser() {
  assert.ok(mediaModule, "media signature parser module must exist");
  return mediaModule;
}

function checksum(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= bytes[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const cases = [
  ["tiny.png", "image", "png", null],
  ["tiny.jpg", "image", "jpeg", null],
  ["tiny.webp", "image", "webp", null],
  ["tiny.gif", "image", "gif", null],
  ["loop-h264.mp4", "video", "mp4", "h264"],
  ["loop-vp9.webm", "video", "webm", "vp9"],
  ["tone-pcm.wav", "ambient", "wav", "pcm"],
  ["tone.mp3", "ui-sound", "mp3", "mp3"],
  ["tone-aac.m4a", "ambient", "m4a", "aac"],
];

test("sniffs and inspects every accepted synthetic media family", async () => {
  const { sniffMediaFile, inspectMediaFile } = parser();
  for (const [name, role, container, codec] of cases) {
    const filePath = path.join(fixtureRoot, name);
    const sniffed = await sniffMediaFile(filePath);
    assert.equal(sniffed.container, container, name);
    const info = await inspectMediaFile(filePath, { role });
    assert.equal(info.container, container, name);
    if (codec) assert.equal(info.codec, codec, name);
    assert.ok(info.sizeBytes > 0, name);
  }
});

test("accepts APNG filenames as PNG without changing the inspected container", async (t) => {
  const { inspectMediaFile } = parser();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-apng-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const apngPath = path.join(root, "animated.apng");
  await fs.copyFile(path.join(fixtureRoot, "tiny.png"), apngPath);

  const info = await inspectMediaFile(apngPath, { role: "image" });

  assert.equal(info.family, "image");
  assert.equal(info.container, "png");
});

test("H.264 and VP9 fixtures expose bounded video metadata", async () => {
  const { inspectMediaFile } = parser();
  for (const name of ["loop-h264.mp4", "loop-vp9.webm"]) {
    const info = await inspectMediaFile(path.join(fixtureRoot, name), { role: "video" });
    assert.ok(info.durationSeconds > 0 && info.durationSeconds <= 60, name);
    assert.ok(info.width > 0 && info.width <= 3840, name);
    assert.ok(info.height > 0 && info.height <= 2160, name);
    assert.ok(info.fps > 0 && info.fps <= 60, name);
  }
  const mp4 = await inspectMediaFile(path.join(fixtureRoot, "loop-h264.mp4"), { role: "video" });
  assert.equal(mp4.hasAudio, true);
  assert.equal(mp4.audioCodec, "aac");
  assert.ok(mp4.audioChannels > 0 && mp4.audioChannels <= 2);
  assert.ok(mp4.audioSampleRate >= 8000 && mp4.audioSampleRate <= 96000);
});

test("accepts one ISO timing entry per supported video frame while keeping tables bounded", () => {
  const { assertIsoTimingTableBounds } = parser();
  assert.equal(typeof assertIsoTimingTableBounds, "function");
  assert.doesNotThrow(() => assertIsoTimingTableBounds(3_600, 3_600 * 8));
  assert.throws(
    () => assertIsoTimingTableBounds(4_097, 4_097 * 8),
    (error) => error?.code === "MEDIA_LIMIT",
  );
  assert.throws(
    () => assertIsoTimingTableBounds(3_600, 3_599 * 8),
    (error) => error?.code === "MEDIA_SIGNATURE",
  );
});

test("audio fixtures expose bounded duration, rate, and channel metadata", async () => {
  const { inspectMediaFile } = parser();
  for (const name of ["tone-pcm.wav", "tone.mp3", "tone-aac.m4a"]) {
    const info = await inspectMediaFile(path.join(fixtureRoot, name), { role: "ambient" });
    assert.ok(info.durationSeconds > 0 && info.durationSeconds <= 600, name);
    assert.ok(info.sampleRate > 0 && info.sampleRate <= 96000, name);
    assert.ok(info.channels > 0 && info.channels <= 2, name);
  }
});

test("rejects truncation, renamed executables, extension mismatch, and hostile lengths", async (t) => {
  const { inspectMediaFile, sniffMediaFile } = parser();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-reject-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake.mp4");
  const truncated = path.join(root, "truncated.mp4");
  const mismatch = path.join(root, "renamed.wav");
  const hostile = path.join(root, "hostile.webp");
  await fs.writeFile(fake, Buffer.from("MZ\0\0not-media"));
  const mp4 = await fs.readFile(path.join(fixtureRoot, "loop-h264.mp4"));
  await fs.writeFile(truncated, mp4.subarray(0, 24));
  await fs.copyFile(path.join(fixtureRoot, "tone.mp3"), mismatch);
  const webp = Buffer.alloc(32);
  webp.write("RIFF", 0, "ascii"); webp.writeUInt32LE(0xfffffff0, 4);
  webp.write("WEBPVP8X", 8, "ascii"); webp.writeUInt32LE(0xfffffff0, 16);
  await fs.writeFile(hostile, webp);

  await assert.rejects(inspectMediaFile(fake, { role: "video" }), (e) => e?.code === "MEDIA_SIGNATURE");
  await assert.rejects(inspectMediaFile(truncated, { role: "video" }), (e) => e?.code === "MEDIA_SIGNATURE");
  await assert.rejects(sniffMediaFile(mismatch), (e) => e?.code === "MEDIA_EXTENSION");
  await assert.rejects(inspectMediaFile(hostile, { role: "image" }), (e) =>
    ["MEDIA_SIGNATURE", "MEDIA_LIMIT"].includes(e?.code));
});

test("rejects polyglot tails, unsupported codecs, and absurd declared metadata", async (t) => {
  const { inspectMediaFile } = parser();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-adversarial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const polyglot = path.join(root, "polyglot.png");
  const unsupported = path.join(root, "unsupported.mp4");
  const absurd = path.join(root, "absurd.png");
  const png = await fs.readFile(path.join(fixtureRoot, "tiny.png"));
  await fs.writeFile(polyglot, Buffer.concat([png, Buffer.from("MZ-not-an-image-tail")]));
  const mp4 = Buffer.from(await fs.readFile(path.join(fixtureRoot, "loop-h264.mp4")));
  const sampleEntry = mp4.lastIndexOf(Buffer.from("avc1"));
  assert.ok(sampleEntry > 0, "fixture must contain an avc1 sample entry");
  mp4.write("hvc1", sampleEntry, "ascii");
  await fs.writeFile(unsupported, mp4);
  const hugePng = Buffer.from(png);
  hugePng.writeUInt32BE(50_000, 16);
  hugePng.writeUInt32BE(checksum(hugePng, 12, 29), 29);
  await fs.writeFile(absurd, hugePng);

  await assert.rejects(inspectMediaFile(polyglot, { role: "image" }), (e) => e?.code === "MEDIA_SIGNATURE");
  await assert.rejects(inspectMediaFile(unsupported, { role: "video" }), (e) => e?.code === "MEDIA_CODEC");
  await assert.rejects(inspectMediaFile(absurd, { role: "image" }), (e) => e?.code === "MEDIA_LIMIT");
});

function pngWithoutImageData(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (bytes.toString("latin1", offset + 4, offset + 8) !== "IDAT") {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return Buffer.concat(parts);
}

function jpegWithoutScanData(bytes) {
  const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scan > 2, "JPEG fixture must contain a start-of-scan marker");
  return Buffer.concat([bytes.subarray(0, scan), Buffer.from([0xff, 0xd9])]);
}

function gifWithoutFrames(bytes) {
  const packed = bytes[10];
  const colorTableBytes = packed & 0x80 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0;
  return Buffer.concat([bytes.subarray(0, 13 + colorTableBytes), Buffer.from([0x3b])]);
}

function isoWithoutMediaData(bytes) {
  const parts = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= bytes.length, "ISO fixture must have bounded top-level boxes");
    if (bytes.toString("latin1", offset + 4, offset + 8) !== "mdat") {
      parts.push(bytes.subarray(offset, offset + size));
    }
    offset += size;
  }
  return Buffer.concat(parts);
}

test("rejects metadata-only media containers without a real payload", async (t) => {
  const { inspectMediaFile } = parser();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-payload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const png = await fs.readFile(path.join(fixtureRoot, "tiny.png"));
  const jpeg = await fs.readFile(path.join(fixtureRoot, "tiny.jpg"));
  const gif = await fs.readFile(path.join(fixtureRoot, "tiny.gif"));
  const mp4 = await fs.readFile(path.join(fixtureRoot, "loop-h264.mp4"));
  const webm = Buffer.from(await fs.readFile(path.join(fixtureRoot, "loop-vp9.webm")));
  const mp3 = await fs.readFile(path.join(fixtureRoot, "tone.mp3"));

  const cluster = webm.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  assert.ok(cluster > 0, "WebM fixture must contain a Cluster element");
  webm[cluster + 3] = 0x76;
  assert.equal(mp3.subarray(45, 49).toString("hex"), "fffb7000", "MP3 fixture first frame changed");
  assert.equal(mp3.subarray(358, 362).toString("hex"), "fffb7064", "MP3 fixture second frame changed");

  const candidates = [
    ["metadata.png", pngWithoutImageData(png), "image"],
    ["metadata.jpg", jpegWithoutScanData(jpeg), "image"],
    ["metadata.gif", gifWithoutFrames(gif), "image"],
    ["metadata.mp4", isoWithoutMediaData(mp4), "video"],
    ["metadata.webm", webm, "video"],
    ["metadata.mp3", mp3.subarray(0, 362), "ui-sound"],
  ];

  for (const [name, bytes, role] of candidates) {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, bytes);
    await assert.rejects(
      inspectMediaFile(filePath, { role }),
      (error) => error?.code === "MEDIA_SIGNATURE",
      name,
    );
  }
});

test("rejects PNG chunks whose payload no longer matches their checksum", async (t) => {
  const { inspectMediaFile } = parser();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-media-crc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(await fs.readFile(path.join(fixtureRoot, "tiny.png")));
  const idat = bytes.indexOf(Buffer.from("IDAT"));
  assert.ok(idat > 8, "PNG fixture must contain image data");
  bytes[idat + 4] ^= 0x01;
  const filePath = path.join(root, "bad-crc.png");
  await fs.writeFile(filePath, bytes);

  await assert.rejects(
    inspectMediaFile(filePath, { role: "image" }),
    (error) => error?.code === "MEDIA_SIGNATURE",
  );
});

test("role limits reject video as UI sound and oversized declared metadata", async () => {
  const { inspectMediaFile, assertMediaWithinLimits } = parser();
  await assert.rejects(
    inspectMediaFile(path.join(fixtureRoot, "loop-h264.mp4"), { role: "ui-sound" }),
    (e) => e?.code === "MEDIA_ROLE",
  );
  assert.throws(() => assertMediaWithinLimits({
    family: "video", width: 7680, height: 4320, fps: 120, durationSeconds: 61, sizeBytes: 1,
  }, "video"), (e) => e?.code === "MEDIA_LIMIT");
  assert.throws(() => assertMediaWithinLimits({
    family: "audio", channels: 2, sampleRate: 48000, durationSeconds: 601, sizeBytes: 1,
  }, "ambient"), (e) => e?.code === "MEDIA_LIMIT");
});
