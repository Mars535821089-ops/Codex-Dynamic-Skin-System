#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { decodeAndValidateSafeCss } from "./safe-css-validator.mjs";
import { validateLegacyThemeDefinition } from "./dynamic/theme-loader.mjs";
import {
  canonicalAssetPath,
  collectThemeAssetPaths,
  THEME_CAPABILITIES,
  THEME_LIMITS,
  validateThemeDefinition,
} from "./dynamic/theme-contract.mjs";
import { inspectMediaFile } from "./dynamic/media-signatures.mjs";

const LIMITS = Object.freeze({
  manifest: 262_144,
  theme: 262_144,
  simpleTheme: 1_048_576,
  css: 262_144,
  image: 10_485_760,
  license: 65_536,
  signature: 4_096,
});

const BACKGROUND_MEDIA = new Map([
  ["background.webp", "image/webp"],
  ["background.jpg", "image/jpeg"],
  ["background.png", "image/png"],
]);
const PAYLOAD_MEDIA = new Map([
  ["theme.json", "application/json"],
  ...BACKGROUND_MEDIA,
  ["theme.css", "text/css"],
  ["LICENSE.txt", "text/plain"],
]);
const PACKAGE_FILES = new Set([
  "manifest.json",
  "manifest.sig",
  ...PAYLOAD_MEDIA.keys(),
]);
const MANIFEST_REQUIRED = [
  "packageVersion",
  "themeId",
  "version",
  "skinApiVersion",
  "minClientVersion",
  "platforms",
  "capabilities",
  "publisher",
  "license",
  "provenance",
  "files",
  "createdAt",
];
const COLOR_KEYS = [
  "background",
  "panel",
  "panelAlt",
  "accent",
  "accentAlt",
  "secondary",
  "highlight",
  "text",
  "muted",
  "line",
];
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .+()-]*$/;
const KEY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const PROVENANCE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const COLOR_PATTERN = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|#[0-9a-fA-F]{3,4}|rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\)|rgba\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*(0|1|1\.0|0?\.[0-9]{1,6})\s*\))$/;
const RFC3339_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const decoder = new TextDecoder("utf-8", { fatal: true });
const scriptPath = fileURLToPath(import.meta.url);

export class PackageValidationError extends Error {
  constructor(code, message) { super(message); this.name = "PackageValidationError"; this.code = code; }
}

function fail(message, code = "PACKAGE_INVALID") {
  throw new PackageValidationError(code, message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`Unknown argument: ${flag ?? "<missing>"}`);
    const key = flag.slice(2);
    if (!new Set(["source", "stage", "platform", "client-version"]).has(key) || values[key]) {
      fail(`Unknown or repeated argument: ${flag}`);
    }
    values[key] = value;
  }
  for (const key of ["source", "stage", "platform", "client-version"]) {
    if (!values[key]) fail(`Missing --${key}`);
  }
  if (!new Set(["macos", "windows"]).has(values.platform)) {
    fail(`Unsupported platform: ${values.platform}`);
  }
  return values;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
}

export function codePointLength(value) {
  return Array.from(value).length;
}

export function normalizeThemeText(value, fallback, maxCodePoints, name, sourceLabel) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string"
    || CONTROL_PATTERN.test(value)
    || codePointLength(value) > maxCodePoints
  ) {
    throw new Error(`${sourceLabel} has an invalid ${name} field`);
  }
  return value.trim() || fallback;
}

export function normalizeThemeColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return COLOR_PATTERN.test(normalized) ? normalized : fallback;
}

function assertString(value, label, { min = 0, max, pattern, controls = CONTROL_PATTERN } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const length = codePointLength(value);
  if (length < min || (max !== undefined && length > max)) fail(`${label} has an invalid length`);
  if (controls?.test(value)) fail(`${label} contains control characters`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function parseSemver(value, label) {
  assertString(value, label, { min: 1, max: 32, pattern: SEMVER_PATTERN, controls: null });
  return value.split(".").map((part) => BigInt(part));
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function assertStringSet(value, label, { min, max, allowed }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} must contain between ${min} and ${max} values`);
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) fail(`${label} contains an unsupported value`);
    if (seen.has(item)) fail(`${label} repeats ${item}`);
    seen.add(item);
  }
  return seen;
}

function decodeJson(bytes, label) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.includes("\0")) fail(`${label} contains NUL characters`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function expectedLimit(name, simple = false) {
  if (name === "manifest.json") return LIMITS.manifest;
  if (name === "theme.json") return simple ? LIMITS.simpleTheme : LIMITS.theme;
  if (name === "theme.css") return LIMITS.css;
  if (name === "LICENSE.txt") return LIMITS.license;
  if (name === "manifest.sig") return LIMITS.signature;
  if (BACKGROUND_MEDIA.has(name) || /\.(?:png|jpe?g|webp)$/i.test(name)) return LIMITS.image;
  return 0;
}

function sameFileStat(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableFile(root, name, maxBytes) {
  const canonical = canonicalAssetPath(name);
  if (canonical !== name || maxBytes < 1) fail(`Unsafe package file name: ${name}`, "ASSET_PATH");
  const filePath = path.join(root, ...name.split("/"));
  let handle;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS);
  } catch (error) {
    if (error.code === "ELOOP") fail(`${name} must not be a symbolic link`);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      fail(`${name} must be a non-empty regular file no larger than ${maxBytes} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileStat(before, after) || bytes.length !== after.size) fail(`${name} changed while being read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function resolveDirectory(directory, label, requireEmpty = false) {
  const original = await fs.lstat(directory);
  if (!original.isDirectory() || original.isSymbolicLink()) fail(`${label} must be a real directory`);
  const resolved = await fs.realpath(directory);
  if (requireEmpty && (await fs.readdir(resolved)).length !== 0) fail(`${label} must be empty`);
  return resolved;
}

async function sourceFileNames(root) {
  const names = [];
  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = canonicalAssetPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) fail(`Theme package contains a symbolic link: ${name}`, "ASSET_PATH");
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (entry.isFile()) names.push(name);
      else fail(`Theme package contains a non-regular entry: ${name}`, "ASSET_PATH");
    }
  }
  await walk(root);
  if (names.length < 1) fail("Theme package is empty");
  if (names.length > THEME_LIMITS.zipEntries) fail("Theme package contains too many files", "ZIP_LIMIT");
  const folded = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (folded.has(key)) fail(`Theme package contains a case-fold collision: ${folded.get(key)} and ${name}`, "PATH_COLLISION");
    folded.set(key, name);
  }
  return names.sort();
}

function validateTimestamp(value) {
  assertString(value, "manifest.createdAt", { min: 1, max: 40, pattern: RFC3339_PATTERN, controls: null });
  const match = RFC3339_PATTERN.exec(value);
  if (!match) fail("manifest.createdAt is not a valid date-time");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendarValid = month >= 1 && month <= 12
    && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
  if (!calendarValid || !Number.isFinite(Date.parse(value))) {
    fail("manifest.createdAt is not a valid date-time");
  }
}

export function validateOfficialThemeDefinition(value) {
  const theme = validateLegacyThemeDefinition(value);
  assertString(theme.id, "theme.json.id", { min: 3, max: 64, pattern: THEME_ID_PATTERN, controls: null });
  assertString(theme.image, "theme.json.image", { min: 1, max: 32, controls: null });
  if (!BACKGROUND_MEDIA.has(theme.image)) fail("theme.json.image must name one registered background file");
  if (theme.art !== undefined) {
    if (theme.art.safeArea !== undefined && !new Set(["left", "right", "none"]).has(theme.art.safeArea)) {
      fail("theme.json.art.safeArea is unsupported");
    }
    if (theme.art.taskMode !== undefined && !new Set(["ambient", "full", "off"]).has(theme.art.taskMode)) {
      fail("theme.json.art.taskMode is unsupported");
    }
  }
  if (theme.colors !== undefined) {
    const colors = assertObject(theme.colors, "theme.json.colors");
    assertExactKeys(colors, COLOR_KEYS, [], "theme.json.colors");
    for (const key of COLOR_KEYS) {
      assertString(colors[key], `theme.json.colors.${key}`, {
        min: 1,
        max: 64,
        pattern: COLOR_PATTERN,
        controls: null,
      });
    }
  }
  return theme;
}

function validateManifest(value, platform, clientVersion) {
  const manifest = assertObject(value, "manifest.json");
  assertExactKeys(manifest, MANIFEST_REQUIRED, ["keyId"], "manifest.json");
  if (manifest.packageVersion !== 1) fail("manifest.json must use packageVersion 1");
  if (manifest.skinApiVersion !== 1) fail("manifest.json requires an unsupported Skin API version");
  assertString(manifest.themeId, "manifest.themeId", {
    min: 3,
    max: 64,
    pattern: THEME_ID_PATTERN,
    controls: null,
  });
  parseSemver(manifest.version, "manifest.version");
  const requiredClient = parseSemver(manifest.minClientVersion, "manifest.minClientVersion");
  const installedClient = parseSemver(clientVersion, "client version");
  if (compareSemver(requiredClient, installedClient) > 0) {
    fail(`Theme requires Dream Skin ${manifest.minClientVersion} or newer; installed version is ${clientVersion}`);
  }
  const platforms = assertStringSet(manifest.platforms, "manifest.platforms", {
    min: 1,
    max: 2,
    allowed: new Set(["macos", "windows"]),
  });
  if (!platforms.has(platform)) fail(`Theme package does not support ${platform}`);
  const capabilities = assertStringSet(manifest.capabilities, "manifest.capabilities", {
    min: 1,
    max: 3,
    allowed: new Set(["background", "tokens", "safe-css"]),
  });

  const publisher = assertObject(manifest.publisher, "manifest.publisher");
  assertExactKeys(publisher, ["id", "displayName"], [], "manifest.publisher");
  assertString(publisher.id, "manifest.publisher.id", {
    min: 1,
    max: 64,
    pattern: PUBLISHER_ID_PATTERN,
    controls: null,
  });
  assertString(publisher.displayName, "manifest.publisher.displayName", { min: 1, max: 80 });
  assertString(manifest.license, "manifest.license", {
    min: 1,
    max: 64,
    pattern: LICENSE_PATTERN,
    controls: null,
  });
  const provenance = assertObject(manifest.provenance, "manifest.provenance");
  assertExactKeys(provenance, ["aiGenerated", "summary"], [], "manifest.provenance");
  if (typeof provenance.aiGenerated !== "boolean") fail("manifest.provenance.aiGenerated must be boolean");
  assertString(provenance.summary, "manifest.provenance.summary", {
    min: 1,
    max: 500,
    controls: PROVENANCE_CONTROL_PATTERN,
  });
  if (manifest.keyId !== undefined) {
    assertString(manifest.keyId, "manifest.keyId", {
      min: 1,
      max: 64,
      pattern: KEY_ID_PATTERN,
      controls: null,
    });
  }
  validateTimestamp(manifest.createdAt);

  if (!Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 8) {
    fail("manifest.files must contain between 2 and 8 entries");
  }
  const files = new Map();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = assertObject(manifest.files[index], `manifest.files[${index}]`);
    assertExactKeys(entry, ["path", "mediaType", "bytes", "sha256"], [], `manifest.files[${index}]`);
    if (typeof entry.path !== "string" || !PAYLOAD_MEDIA.has(entry.path)) {
      fail(`manifest.files[${index}].path is unsupported`);
    }
    if (files.has(entry.path)) fail(`manifest.files repeats ${entry.path}`);
    if (entry.mediaType !== PAYLOAD_MEDIA.get(entry.path)) {
      fail(`manifest.files mediaType does not match ${entry.path}`);
    }
    const limit = expectedLimit(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > limit) {
      fail(`manifest.files bytes for ${entry.path} exceed its limit`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(`manifest.files SHA-256 for ${entry.path} is invalid`);
    }
    files.set(entry.path, entry);
  }
  const backgrounds = [...files.keys()].filter((name) => BACKGROUND_MEDIA.has(name));
  if (!files.has("theme.json") || backgrounds.length !== 1) {
    fail("manifest.files must contain theme.json and exactly one background file");
  }
  if (files.has("theme.css") !== capabilities.has("safe-css")) {
    fail("theme.css presence must match the safe-css capability");
  }
  if (!files.has("theme.css")) {
    fail("New official theme imports require theme.css and the safe-css capability");
  }
  return { manifest, files, background: backgrounds[0] };
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectedImageMedia(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString() === "RIFF"
    && bytes.subarray(8, 12).toString() === "WEBP"
  ) return "image/webp";
  return "";
}

const V2_MEDIA_TYPES = Object.freeze({
  ".json": "application/json", ".css": "text/css", ".txt": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
});

function mediaTypeForPath(fileName) { return V2_MEDIA_TYPES[path.posix.extname(fileName).toLowerCase()]; }

function v2EntryLimit(fileName) {
  const extension = path.posix.extname(fileName).toLowerCase();
  if ([".json", ".css", ".txt"].includes(extension)) return THEME_LIMITS.textBytes;
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return THEME_LIMITS.imageBytes;
  if ([".mp4", ".webm"].includes(extension)) return THEME_LIMITS.videoBytes;
  if ([".wav", ".mp3", ".m4a"].includes(extension)) return THEME_LIMITS.ambientBytes;
  return 0;
}

function validateV2Manifest(manifest, platform, clientVersion) {
  const base = assertObject(manifest, "manifest.json");
  assertExactKeys(base, MANIFEST_REQUIRED, ["keyId"], "manifest.json");
  if (base.packageVersion !== 1 || base.skinApiVersion !== 2) fail("manifest.json version is unsupported", "SCHEMA_VERSION");
  assertString(base.themeId, "manifest.themeId", { min: 3, max: 128, pattern: THEME_ID_PATTERN, controls: null });
  parseSemver(base.version, "manifest.version");
  if (compareSemver(parseSemver(base.minClientVersion, "manifest.minClientVersion"), parseSemver(clientVersion, "client version")) > 0) {
    fail(`Theme requires Dream Skin ${base.minClientVersion} or newer; installed version is ${clientVersion}`);
  }
  if (!assertStringSet(base.platforms, "manifest.platforms", { min: 1, max: 2, allowed: new Set(["macos", "windows"]) }).has(platform)) {
    fail(`Theme package does not support ${platform}`);
  }
  assertStringSet(base.capabilities, "manifest.capabilities", { min: 0, max: THEME_CAPABILITIES.length, allowed: new Set(THEME_CAPABILITIES) });
  const publisher = assertObject(base.publisher, "manifest.publisher");
  assertExactKeys(publisher, ["id", "displayName"], [], "manifest.publisher");
  assertString(publisher.id, "manifest.publisher.id", { min: 1, max: 64, pattern: PUBLISHER_ID_PATTERN, controls: null });
  assertString(publisher.displayName, "manifest.publisher.displayName", { min: 1, max: 80 });
  assertString(base.license, "manifest.license", { min: 1, max: 64, pattern: LICENSE_PATTERN, controls: null });
  const provenance = assertObject(base.provenance, "manifest.provenance");
  assertExactKeys(provenance, ["aiGenerated", "summary"], [], "manifest.provenance");
  if (typeof provenance.aiGenerated !== "boolean") fail("manifest.provenance.aiGenerated must be boolean");
  assertString(provenance.summary, "manifest.provenance.summary", { min: 1, max: 500, controls: PROVENANCE_CONTROL_PATTERN });
  validateTimestamp(base.createdAt);
  if (!Array.isArray(base.files) || base.files.length < 1 || base.files.length > THEME_LIMITS.zipEntries - 1) {
    fail("manifest.files exceeds the package entry limit", "ZIP_LIMIT");
  }
  const files = new Map();
  for (let index = 0; index < base.files.length; index += 1) {
    const entry = assertObject(base.files[index], `manifest.files[${index}]`);
    assertExactKeys(entry, ["path", "mediaType", "bytes", "sha256"], [], `manifest.files[${index}]`);
    const fileName = canonicalAssetPath(entry.path);
    if (fileName !== entry.path || files.has(fileName)) fail(`manifest.files repeats or aliases ${entry.path}`, "PATH_COLLISION");
    const expectedType = mediaTypeForPath(fileName);
    if (!expectedType) fail(`manifest.files contains disallowed file ${fileName}`, "UNDECLARED_FILE");
    if (entry.mediaType !== expectedType) fail(`manifest.files mediaType does not match ${fileName}`, "MEDIA_EXTENSION");
    const entryLimit = v2EntryLimit(fileName);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > entryLimit) {
      fail(`manifest.files bytes for ${fileName} exceed its limit`, "ZIP_LIMIT");
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`manifest.files SHA-256 for ${fileName} is invalid`);
    files.set(fileName, entry);
  }
  if (!files.has("theme.json")) fail("manifest.files is missing theme.json", "MISSING_FILE");
  return { manifest: base, files };
}

function mediaRoles(theme) {
  const roles = new Map();
  if (theme.visual.kind === "image") roles.set(theme.visual.asset, "image");
  if (theme.visual.kind === "video") {
    roles.set(theme.visual.asset, "video");
    if (theme.visual.poster) roles.set(theme.visual.poster, "poster");
  }
  if (theme.visual.kind === "builtin-effect") {
    if (theme.visual.fallback.video) roles.set(theme.visual.fallback.video, "video");
    roles.set(theme.visual.fallback.poster, "poster");
  }
  if (theme.audio.ambient.source === "asset") roles.set(theme.audio.ambient.asset, "ambient");
  for (const asset of Object.values(theme.audio.ui.events)) roles.set(asset, "ui-sound");
  return roles;
}

async function validateOfficialV2(root, names, rawManifest, platform, clientVersion) {
  const { manifest, files } = validateV2Manifest(rawManifest, platform, clientVersion);
  const actualPayload = new Set(names.filter((name) => !["manifest.json", "manifest.sig"].includes(name)));
  if (!setsEqual(actualPayload, new Set(files.keys()))) fail("ZIP payload files do not exactly match manifest.files", "UNDECLARED_FILE");
  const bytes = new Map([["manifest.json", await readStableFile(root, "manifest.json", LIMITS.manifest)]]);
  if (names.includes("manifest.sig")) bytes.set("manifest.sig", await readStableFile(root, "manifest.sig", LIMITS.signature));
  for (const [name, entry] of files) {
    const data = await readStableFile(root, name, v2EntryLimit(name));
    if (data.length !== entry.bytes) fail(`${name} byte length does not match manifest.json`, "ZIP_LIMIT");
    if (sha256(data) !== entry.sha256) fail(`${name} SHA-256 does not match manifest.json`, "HASH_MISMATCH");
    bytes.set(name, data);
  }
  const rawTheme = decodeJson(bytes.get("theme.json"), "theme.json");
  const theme = validateThemeDefinition(rawTheme, files.keys());
  if (manifest.themeId !== theme.id || manifest.version !== theme.version) fail("manifest identity does not match theme.json", "MANIFEST_MISMATCH");
  if (!setsEqual(new Set(manifest.capabilities), new Set(theme.capabilities))) fail("manifest capabilities do not match theme.json", "CAPABILITY_MISMATCH");
  const expectedPayload = new Set(["theme.json", ...collectThemeAssetPaths(theme)]);
  if (files.has("LICENSE.txt")) expectedPayload.add("LICENSE.txt");
  if (!setsEqual(expectedPayload, new Set(files.keys()))) fail("Package contains undeclared or missing theme files", "UNDECLARED_FILE");
  if (theme.styles) decodeAndValidateSafeCss(bytes.get(theme.styles));
  const media = [];
  for (const [assetPath, role] of mediaRoles(theme)) {
    const info = await inspectMediaFile(path.join(root, ...assetPath.split("/")), { role });
    if (files.get(assetPath).mediaType !== info.mime) fail(`${assetPath} MIME does not match its content`, "MEDIA_EXTENSION");
    const afterInspect = await readStableFile(root, assetPath, v2EntryLimit(assetPath));
    if (afterInspect.length !== files.get(assetPath).bytes || sha256(afterInspect) !== files.get(assetPath).sha256) {
      fail(`${assetPath} changed during media inspection`, "MEDIA_CHANGED");
    }
    media.push({ path: assetPath, role, ...info });
  }
  if (theme.audio.ambient.source === "visual") {
    const visual = media.find((entry) => entry.role === "video");
    if (!visual?.hasAudio) fail("Ambient source visual requires embedded audio", "MEDIA_CODEC");
  }
  return { format: "official", skinApiVersion: 2, themeId: theme.id,
    declaredAssets: collectThemeAssetPaths(theme), media, safeCssStatus: theme.styles ? "validated" : "none",
    signatureIgnored: names.includes("manifest.sig"), bytes };
}

async function validateOfficial(root, names, platform, clientVersion) {
  if (!names.includes("manifest.json")) fail("Official theme package is missing manifest.json", "MISSING_FILE");
  const manifestBytes = await readStableFile(root, "manifest.json", LIMITS.manifest);
  const rawManifest = decodeJson(manifestBytes, "manifest.json");
  if (rawManifest.skinApiVersion === 2) return validateOfficialV2(root, names, rawManifest, platform, clientVersion);
  for (const name of names) {
    if (!PACKAGE_FILES.has(name)) fail(`Official theme package contains unregistered file ${name}`);
  }
  const bytes = new Map();
  for (const name of names) bytes.set(name, await readStableFile(root, name, expectedLimit(name)));
  const { manifest, files, background } = validateManifest(
    decodeJson(bytes.get("manifest.json"), "manifest.json"),
    platform,
    clientVersion,
  );
  const actualPayload = new Set(names.filter((name) => name !== "manifest.json" && name !== "manifest.sig"));
  if (!setsEqual(actualPayload, new Set(files.keys()))) {
    fail("ZIP payload files do not exactly match manifest.files");
  }
  for (const [name, entry] of files) {
    const data = bytes.get(name);
    if (!data) fail(`manifest.files declares missing file ${name}`);
    if (data.length !== entry.bytes) fail(`${name} byte length does not match manifest.json`);
    if (sha256(data) !== entry.sha256) fail(`${name} SHA-256 does not match manifest.json`);
  }
  const theme = validateOfficialThemeDefinition(decodeJson(bytes.get("theme.json"), "theme.json"));
  if (manifest.themeId !== theme.id) fail("manifest.themeId does not match theme.json id");
  if (theme.image !== background) fail("theme.json image does not match the manifest background file");
  if (detectedImageMedia(bytes.get(background)) !== BACKGROUND_MEDIA.get(background)) {
    fail(`${background} content does not match its extension and mediaType`);
  }
  decodeAndValidateSafeCss(bytes.get("theme.css"));
  return {
    format: "official",
    image: background,
    safeCssStatus: "validated",
    signatureIgnored: bytes.has("manifest.sig"),
    bytes,
  };
}

async function validateSimple(root, names) {
  if (!names.includes("theme.json")) fail("Local simplified ZIP is missing theme.json", "MISSING_FILE");
  const initialThemeBytes = await readStableFile(root, "theme.json", LIMITS.simpleTheme);
  const initialTheme = assertObject(decodeJson(initialThemeBytes, "theme.json"), "theme.json");
  if (initialTheme.schemaVersion === 2) {
    const theme = validateThemeDefinition(initialTheme, names.filter((name) => name !== "theme.json"));
    const expected = new Set(["theme.json", ...collectThemeAssetPaths(theme)]);
    if (!setsEqual(expected, new Set(names))) fail("Simplified v2 package contains undeclared or missing files", "UNDECLARED_FILE");
    const bytes = new Map([["theme.json", initialThemeBytes]]); const media = [];
    for (const assetPath of collectThemeAssetPaths(theme)) {
      const data = await readStableFile(root, assetPath, v2EntryLimit(assetPath)); bytes.set(assetPath, data);
    }
    if (theme.styles) decodeAndValidateSafeCss(bytes.get(theme.styles));
    for (const [assetPath, role] of mediaRoles(theme)) {
      const info = await inspectMediaFile(path.join(root, ...assetPath.split("/")), { role });
      const afterInspect = await readStableFile(root, assetPath, v2EntryLimit(assetPath));
      if (sha256(afterInspect) !== sha256(bytes.get(assetPath))) fail(`${assetPath} changed during media inspection`, "MEDIA_CHANGED");
      media.push({ path: assetPath, role, ...info });
    }
    if (theme.audio.ambient.source === "visual" && !media.find((entry) => entry.role === "video")?.hasAudio) {
      fail("Ambient source visual requires embedded audio", "MEDIA_CODEC");
    }
    return { format: "simple", skinApiVersion: 2, themeId: theme.id,
      declaredAssets: collectThemeAssetPaths(theme), media, safeCssStatus: theme.styles ? "validated" : "none",
      signatureIgnored: false, bytes };
  }
  if (names.length !== 3 || !names.includes("theme.json") || !names.includes("theme.css")) {
    fail("Local simplified ZIP must contain exactly theme.json, theme.css, and its image");
  }
  const themeBytes = initialThemeBytes;
  const theme = initialTheme;
  if (theme.schemaVersion !== 1 || typeof theme.image !== "string" || !theme.image) {
    fail("Local simplified theme must use schemaVersion 1 and name an image");
  }
  if (
    path.basename(theme.image) !== theme.image
    || CONTROL_PATTERN.test(theme.image)
    || !/\.(?:png|jpe?g|webp)$/i.test(theme.image)
    || !names.includes(theme.image)
  ) fail("Local simplified theme image must be beside theme.json");
  const [imageBytes, cssBytes] = await Promise.all([
    readStableFile(root, theme.image, LIMITS.image),
    readStableFile(root, "theme.css", LIMITS.css),
  ]);
  const expectedMedia = /\.png$/i.test(theme.image)
    ? "image/png"
    : /\.webp$/i.test(theme.image) ? "image/webp" : "image/jpeg";
  if (detectedImageMedia(imageBytes) !== expectedMedia) {
    fail(`${theme.image} content does not match its extension`);
  }
  decodeAndValidateSafeCss(cssBytes);
  return {
    format: "simple",
    image: theme.image,
    safeCssStatus: "validated",
    signatureIgnored: false,
    bytes: new Map([
      ["theme.json", themeBytes],
      [theme.image, imageBytes],
      ["theme.css", cssBytes],
    ]),
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = await resolveDirectory(args.source, "Theme package source");
  const stage = await resolveDirectory(args.stage, "Theme package stage", true);
  const names = await sourceFileNames(source);
  const result = names.includes("manifest.json")
    ? await validateOfficial(source, names, args.platform, args["client-version"])
    : await validateSimple(source, names);
  for (const [name, bytes] of result.bytes) {
    const destination = path.join(stage, ...name.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await fs.chmod(destination, 0o600);
  }
  return {
    format: result.format,
    ...(result.image === undefined ? {} : { image: result.image }),
    ...(result.skinApiVersion === undefined ? {} : { skinApiVersion: result.skinApiVersion }),
    ...(result.themeId === undefined ? {} : { themeId: result.themeId }),
    ...(result.declaredAssets === undefined ? {} : { declaredAssets: result.declaredAssets }),
    ...(result.media === undefined ? {} : { media: result.media }),
    safeCssStatus: result.safeCssStatus,
    signatureIgnored: result.signatureIgnored,
  };
}

if (path.resolve(process.argv[1] || "") === path.resolve(scriptPath)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(`Theme package validation failed [${error?.code ?? "PACKAGE_INVALID"}]: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
