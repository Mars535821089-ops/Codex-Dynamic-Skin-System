#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectMediaFile } from "../runtime/dynamic/media-signatures.mjs";
import {
  collectThemeAssetPaths,
  validateThemeDefinition,
} from "../runtime/dynamic/theme-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const validatorPath = path.join(repoRoot, "runtime/theme-package-validator.mjs");
const FIXED_CREATED_AT = "2026-08-27T00:00:00Z";
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const UI_PATHS = Object.freeze({
  taskCompleted: "task-completed",
  approvalRequested: "approval-requested",
  taskFailed: "task-failed",
});

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFor(info) {
  return info.container === "jpeg" ? "jpg" : info.container;
}

function mediaTypeForPath(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  return Object.freeze({
    ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  })[extension];
}

function sameFile(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableInput(filePath) {
  const resolved = path.resolve(filePath);
  const before = await fs.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Media input must be a regular file: ${resolved}`);
  }
  const handle = await fs.open(resolved, OPEN_FLAGS);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error(`Media input changed while opening: ${resolved}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(opened, after) || bytes.length !== opened.size) {
      throw new Error(`Media input changed while reading: ${resolved}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inspectAndRead(filePath, role) {
  const resolved = path.resolve(filePath);
  const info = await inspectMediaFile(resolved, { role });
  const bytes = await readStableInput(resolved);
  return { info, bytes };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const [name, bytes] of [...entries].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + bytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function writeStagingFiles(root, entries) {
  for (const [relativePath, bytes] of entries) {
    const destination = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

function validateWithSharedValidator(source) {
  const stage = path.join(path.dirname(source), "validated");
  return fs.mkdir(stage, { mode: 0o700 }).then(() => {
    const result = spawnSync(process.execPath, [
      validatorPath,
      "--source", source,
      "--stage", stage,
      "--platform", "macos",
      "--client-version", "2.0.0",
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Theme package validation failed");
    }
  });
}

function assertAmbientMode(options) {
  const selected = [options.ambientFromVideo, Boolean(options.ambient), options.muteVideo]
    .filter(Boolean).length;
  if (selected !== 1) {
    throw new Error("--ambient-from-video, --ambient, and --mute-video are mutually exclusive; choose exactly one");
  }
}

export async function buildThemePackage(options) {
  if (!options || typeof options !== "object") throw new Error("Theme package options are required");
  if (!options.output) throw new Error("Theme package output is required");
  const visualInputCount = [options.video, options.image, options.voxelField]
    .filter(Boolean).length;
  if (visualInputCount !== 1) {
    throw new Error("Choose exactly one visual input: video, image, or first-party voxel field");
  }
  assertAmbientMode(options);
  const output = path.resolve(options.output);
  if (path.extname(output).toLowerCase() !== ".codexskin") {
    throw new Error("Theme package output must use the .codexskin extension");
  }
  if (!options.force) {
    try {
      await fs.lstat(output);
      throw new Error(`Theme package already exists: ${output}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const payload = new Map();
  let visual;
  let visualAudioInfo;
  if (options.video) {
    const media = await inspectAndRead(options.video, "video");
    const asset = `media/visual.${extensionFor(media.info)}`;
    payload.set(asset, media.bytes);
    visual = { kind: "video", asset, fit: "adaptive", opacity: 1, overscan: 1.02, loop: true };
    visualAudioInfo = media.info;
  } else if (options.voxelField) {
    if (!options.poster) throw new Error("A first-party voxel field requires a poster fallback");
    const poster = await inspectAndRead(options.poster, "poster");
    const posterAsset = `media/poster.${extensionFor(poster.info)}`;
    payload.set(posterAsset, poster.bytes);

    const fallback = { poster: posterAsset };
    if (options.fallbackVideo) {
      const media = await inspectAndRead(options.fallbackVideo, "video");
      const videoAsset = `media/fallback.${extensionFor(media.info)}`;
      payload.set(videoAsset, media.bytes);
      fallback.video = videoAsset;
      visualAudioInfo = media.info;
    }
    visual = {
      kind: "builtin-effect",
      effect: "voxel-field",
      fallback,
      fit: "adaptive",
      opacity: 1,
    };
  } else {
    const media = await inspectAndRead(options.image, "image");
    const asset = `media/visual.${extensionFor(media.info)}`;
    payload.set(asset, media.bytes);
    visual = { kind: "image", asset, fit: "adaptive", opacity: 1 };
  }
  if (options.poster && !options.voxelField) {
    if (!options.video) {
      throw new Error("A poster is only valid for a video or first-party voxel theme");
    } else {
      const media = await inspectAndRead(options.poster, "poster");
      const asset = `media/poster.${extensionFor(media.info)}`;
      payload.set(asset, media.bytes);
      visual.poster = asset;
    }
  }
  if (options.fallbackVideo && !options.voxelField) {
    throw new Error("A fallback video is only valid for a first-party voxel theme");
  }

  let ambient;
  if (options.ambientFromVideo) {
    if (!visualAudioInfo) {
      throw new Error("Embedded ambient audio requires a video visual or voxel fallback video");
    }
    if (!visualAudioInfo.hasAudio) throw new Error("Selected video does not contain a supported embedded audio track");
    ambient = { source: "visual", loop: true, volume: 0.7, analyze: true };
  } else if (options.ambient) {
    const media = await inspectAndRead(options.ambient, "ambient");
    const asset = `audio/ambient.${extensionFor(media.info)}`;
    payload.set(asset, media.bytes);
    ambient = { source: "asset", asset, loop: true, volume: 0.7, analyze: true };
  } else {
    ambient = { source: "none", loop: true, volume: 0.7, analyze: false };
  }

  const uiEvents = {};
  for (const eventName of Object.keys(UI_PATHS)) {
    const input = options.ui?.[eventName];
    if (!input) continue;
    const media = await inspectAndRead(input, "ui-sound");
    const asset = `audio/ui/${UI_PATHS[eventName]}.${extensionFor(media.info)}`;
    if (payload.has(asset)) throw new Error(`Canonical package path collision: ${asset}`);
    payload.set(asset, media.bytes);
    uiEvents[eventName] = asset;
  }

  const hasSound = ambient.source !== "none" || Object.keys(uiEvents).length > 0;
  const effect = visual.kind === "builtin-effect" ? {
    id: "voxel-field",
    source: ambient.source === "none" ? "none" : "ambient",
    parameters: {
      gridSize: 48,
      height: 3.2,
      smoothing: 0.72,
      bloom: 0.35,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    },
  } : undefined;
  const rawTheme = {
    schemaVersion: 2,
    id: options.id,
    name: options.name,
    version: options.version ?? "1.0.0",
    capabilities: [
      ...(["video", "builtin-effect"].includes(visual.kind) ? ["animated-background"] : []),
      ...(hasSound ? ["sound-pack"] : []),
      ...(visual.kind === "builtin-effect" ? ["builtin-effect"] : []),
    ],
    visual,
    audio: {
      ambient,
      ui: { volume: 0.8, events: uiEvents },
    },
    ...(effect ? { effect } : {}),
  };
  const theme = validateThemeDefinition(rawTheme, payload.keys());
  const themeBytes = jsonBytes(theme);
  payload.set("theme.json", themeBytes);

  const files = [...payload]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([filePath, bytes]) => ({
      path: filePath,
      mediaType: mediaTypeForPath(filePath),
      bytes: bytes.length,
      sha256: sha256(bytes),
    }));
  const manifest = {
    packageVersion: 1,
    themeId: theme.id,
    version: theme.version,
    skinApiVersion: 2,
    minClientVersion: "2.0.0",
    platforms: ["macos", "windows"],
    capabilities: theme.capabilities,
    publisher: { id: "local-builder", displayName: "Local Theme Builder" },
    license: "Proprietary",
    provenance: { aiGenerated: false, summary: "Built locally without media transcoding." },
    files,
    createdAt: FIXED_CREATED_AT,
  };
  const archiveEntries = new Map(payload);
  archiveEntries.set("manifest.json", jsonBytes(manifest));

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexskin-build-"));
  const source = path.join(stagingRoot, "source");
  await fs.mkdir(source, { mode: 0o700 });
  try {
    await writeStagingFiles(source, archiveEntries);
    await validateWithSharedValidator(source);
    const archive = storedZip(archiveEntries);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporaryOutput = path.join(
      path.dirname(output),
      `.${path.basename(output)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temporaryOutput, archive, { flag: "wx", mode: 0o600 });
      if (!options.force) {
        try {
          await fs.link(temporaryOutput, output);
        } catch (error) {
          if (error?.code === "EEXIST") throw new Error(`Theme package already exists: ${output}`);
          throw error;
        }
        await fs.unlink(temporaryOutput);
      } else {
        await fs.rename(temporaryOutput, output);
      }
    } finally {
      await fs.rm(temporaryOutput, { force: true });
    }
    return Object.freeze({ output, theme, manifest, entryNames: [...archiveEntries.keys()].sort() });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const valueFlags = new Map([
    ["--id", "id"], ["--name", "name"], ["--version", "version"],
    ["--video", "video"], ["--image", "image"], ["--poster", "poster"],
    ["--fallback-video", "fallbackVideo"],
    ["--ambient", "ambient"], ["--ui-task-completed", "ui.taskCompleted"],
    ["--ui-approval-requested", "ui.approvalRequested"],
    ["--ui-task-failed", "ui.taskFailed"], ["--output", "output"],
  ]);
  const booleanFlags = new Map([
    ["--voxel-field", "voxelField"],
    ["--ambient-from-video", "ambientFromVideo"],
    ["--mute-video", "muteVideo"], ["--force", "force"],
  ]);
  const result = { ui: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      const key = booleanFlags.get(flag);
      if (result[key]) throw new Error(`Repeated argument: ${flag}`);
      result[key] = true;
      continue;
    }
    const key = valueFlags.get(flag);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
    if (key.startsWith("ui.")) {
      const eventName = key.slice(3);
      if (result.ui[eventName]) throw new Error(`Repeated argument: ${flag}`);
      result.ui[eventName] = value;
    } else {
      if (result[key] !== undefined) throw new Error(`Repeated argument: ${flag}`);
      result[key] = value;
    }
  }
  return result;
}

if (path.resolve(process.argv[1] || "") === path.resolve(scriptPath)) {
  try {
    const result = await buildThemePackage(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ output: result.output, themeId: result.theme.id })}\n`);
  } catch (error) {
    process.stderr.write(`Theme package build failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
