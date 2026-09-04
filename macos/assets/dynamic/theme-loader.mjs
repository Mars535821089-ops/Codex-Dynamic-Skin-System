import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { decodeAndValidateSafeCss } from "../safe-css-validator.mjs";
import { verifyContentManifest } from "./content-manifest.mjs";
import {
  canonicalAssetPath,
  THEME_LIMITS,
  validateThemeDefinition,
} from "./theme-contract.mjs";

const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const V1_ROOT_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "brandSubtitle",
  "tagline",
  "projectPrefix",
  "projectLabel",
  "statusText",
  "quote",
  "promoTitle",
  "promoSub",
  "promoUrl",
  "image",
  "appearance",
  "art",
  "colors",
]);
const V1_COPY_KEYS = [
  "brandSubtitle",
  "tagline",
  "projectPrefix",
  "projectLabel",
  "statusText",
  "quote",
  "promoTitle",
  "promoSub",
];
const V1_COLOR_KEYS = [
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
const V2_TOKEN_KEYS = ["background", "panel", "accent", "accentAlt", "text", "muted", "line"];
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const FULL_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function normalizeText(value, label, { min = 0, max = 120 } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  const length = Array.from(normalized).length;
  if (CONTROL_PATTERN.test(normalized) || length < min || length > max) {
    fail(`${label} has an invalid length or control characters`);
  }
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
}

export function validateLegacyThemeDefinition(raw) {
  const value = assertObject(raw, "theme.json");
  assertAllowedKeys(value, V1_ROOT_KEYS, "theme.json");
  if (value.schemaVersion !== 1) fail("theme.json must use schemaVersion 1");
  const id = normalizeText(value.id, "theme.json.id", { min: 1, max: 80 });
  const name = normalizeText(value.name, "theme.json.name", { min: 1, max: 80 });
  const image = canonicalAssetPath(value.image);
  if (image.includes("/") || !/\.(?:png|jpe?g|webp)$/i.test(image)) {
    fail("theme.json.image must name a supported image beside theme.json");
  }
  const normalized = { schemaVersion: 1, id, name, image };
  for (const key of V1_COPY_KEYS) {
    if (value[key] !== undefined) normalized[key] = normalizeText(value[key], `theme.json.${key}`);
  }
  if (value.promoUrl !== undefined) {
    normalized.promoUrl = normalizeText(value.promoUrl, "theme.json.promoUrl", { max: 512 });
  }
  if (value.appearance !== undefined) {
    if (!["auto", "light", "dark"].includes(value.appearance)) fail("theme.json.appearance is unsupported");
    normalized.appearance = value.appearance;
  }
  if (value.art !== undefined) {
    const art = assertObject(value.art, "theme.json.art");
    const allowed = new Set(["focusX", "focusY", "safeArea", "taskMode"]);
    assertAllowedKeys(art, allowed, "theme.json.art");
    const normalizedArt = {};
    for (const key of ["focusX", "focusY"]) {
      if (art[key] !== undefined) {
        if (typeof art[key] !== "number" || !Number.isFinite(art[key]) || art[key] < 0 || art[key] > 1) {
          fail(`theme.json.art.${key} must be between 0 and 1`);
        }
        normalizedArt[key] = art[key];
      }
    }
    if (art.safeArea !== undefined) {
      if (!["auto", "left", "right", "center", "none"].includes(art.safeArea)) {
        fail("theme.json.art.safeArea is unsupported");
      }
      normalizedArt.safeArea = art.safeArea;
    }
    if (art.taskMode !== undefined) {
      if (!["auto", "ambient", "banner", "full", "off"].includes(art.taskMode)) {
        fail("theme.json.art.taskMode is unsupported");
      }
      normalizedArt.taskMode = art.taskMode;
    }
    normalized.art = normalizedArt;
  }
  if (value.colors !== undefined) {
    const colors = assertObject(value.colors, "theme.json.colors");
    assertAllowedKeys(colors, new Set(V1_COLOR_KEYS), "theme.json.colors");
    const normalizedColors = {};
    for (const key of V1_COLOR_KEYS) {
      if (colors[key] !== undefined) {
        normalizedColors[key] = normalizeText(colors[key], `theme.json.colors.${key}`, { min: 1, max: 64 });
      }
    }
    normalized.colors = normalizedColors;
  }
  return deepFreeze(normalized);
}

function limitForFile(fileName) {
  const extension = path.posix.extname(fileName).toLowerCase();
  if (fileName === "theme.json" || fileName === "content-manifest.json"
      || extension === ".css" || extension === ".txt") return THEME_LIMITS.textBytes;
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return THEME_LIMITS.imageBytes;
  if ([".mp4", ".webm", ".mov", ".m4v"].includes(extension)) return THEME_LIMITS.videoBytes;
  if ([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac"].includes(extension)) {
    return Math.max(THEME_LIMITS.ambientBytes, THEME_LIMITS.uiClipBytes);
  }
  fail(`Installed theme contains unsupported file ${fileName}`);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function resolveThemeRoot(themeDir) {
  const initial = await fs.lstat(themeDir);
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail("Installed theme root must be a real directory");
  return fs.realpath(themeDir);
}

function snapshotEntry(relativePath, stat) {
  return Object.freeze({
    path: relativePath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

export function normalizePackageFileList(values) {
  if (values == null || typeof values[Symbol.iterator] !== "function") {
    fail("Package file list must be iterable");
  }
  const paths = [...values].map((value) => canonicalAssetPath(value));
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const foldedPaths = new Map();
  for (const fileName of paths) {
    const folded = fileName.toLowerCase();
    const previous = foldedPaths.get(folded);
    if (previous !== undefined) {
      fail(`Installed theme contains a case-fold collision: ${previous} and ${fileName}`);
    }
    foldedPaths.set(folded, fileName);
  }
  return Object.freeze(paths);
}

export async function snapshotRegularFiles(themeDir) {
  const root = await resolveThemeRoot(themeDir);
  const files = [];
  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = canonicalAssetPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) fail(`Installed theme contains symbolic link ${relativePath}`);
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const realPath = await fs.realpath(absolutePath);
        if (!isContained(root, realPath)) fail(`Installed theme file escapes its root: ${relativePath}`);
        const limit = limitForFile(relativePath);
        if (stat.size < 1 || stat.size > limit) {
          fail(`${relativePath} must be a non-empty regular file no larger than ${limit} bytes`);
        }
        files.push(snapshotEntry(relativePath, stat));
      } else {
        fail(`Installed theme contains non-regular entry ${relativePath}`);
      }
    }
  }
  await walk(root);
  const orderedPaths = normalizePackageFileList(files.map((entry) => entry.path));
  const filesByPath = new Map(files.map((entry) => [entry.path, entry]));
  files.splice(0, files.length, ...orderedPaths.map((fileName) => filesByPath.get(fileName)));
  if (files.length < 2 || files.length > THEME_LIMITS.zipEntries) {
    fail(`Installed theme must contain between 2 and ${THEME_LIMITS.zipEntries} files`);
  }
  return deepFreeze({ root, files });
}

function snapshotsEqual(left, right) {
  if (left.root !== right.root || left.files.length !== right.files.length) return false;
  return left.files.every((entry, index) => {
    const other = right.files[index];
    return entry.path === other.path
      && entry.dev === other.dev
      && entry.ino === other.ino
      && entry.size === other.size
      && entry.mtimeMs === other.mtimeMs
      && entry.ctimeMs === other.ctimeMs;
  });
}

async function readStableFile(root, entry) {
  const absolutePath = path.join(root, ...entry.path.split("/"));
  let handle;
  try {
    handle = await fs.open(absolutePath, OPEN_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${entry.path} changed into a symbolic link while being read`);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== entry.dev
      || before.ino !== entry.ino
      || before.size !== entry.size
      || before.mtimeMs !== entry.mtimeMs
      || before.ctimeMs !== entry.ctimeMs
    ) fail(`${entry.path} changed while being read`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== after.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) fail(`${entry.path} changed while being read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function decodeText(bytes, label) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.includes("\0")) fail(`${label} contains NUL characters`);
  return text;
}

function parseThemeJson(bytes) {
  const text = decodeText(bytes, "theme.json");
  try {
    return JSON.parse(text);
  } catch {
    fail("theme.json is not valid JSON");
  }
}

function validateOptions(options) {
  const value = assertObject(options, "loader options");
  if (!["macos", "windows"].includes(value.platform)) fail("loader options.platform is unsupported");
  if (typeof value.clientVersion !== "string" || !FULL_SEMVER_PATTERN.test(value.clientVersion)) {
    fail("loader options.clientVersion must be semantic version syntax");
  }
}

export function adaptV1Theme(legacyTheme, { hasSafeCss = false } = {}) {
  const tokens = {};
  for (const key of V2_TOKEN_KEYS) {
    const value = legacyTheme.colors?.[key];
    if (HEX_COLOR_PATTERN.test(value ?? "")) tokens[key] = value;
  }
  return {
    schemaVersion: 2,
    id: legacyTheme.id,
    name: legacyTheme.name,
    version: "1.0.0",
    capabilities: hasSafeCss ? ["safe-css"] : [],
    visual: {
      kind: "image",
      asset: legacyTheme.image,
      fit: "cover",
      opacity: 1,
    },
    audio: {
      ambient: { source: "none", loop: true, volume: 0.7, analyze: false },
      ui: { volume: 0.8, events: {} },
    },
    ...(hasSafeCss ? { styles: "theme.css" } : {}),
    tokens,
  };
}

export async function loadInstalledSkin(themeDir, options) {
  validateOptions(options);
  const before = await snapshotRegularFiles(themeDir);
  const entries = new Map(before.files.map((entry) => [entry.path, entry]));
  const themeEntry = entries.get("theme.json");
  if (!themeEntry) fail("Installed theme is missing theme.json");
  const digest = createHash("sha256");
  const bytesByPath = new Map();
  for (const entry of before.files) {
    const bytes = await readStableFile(before.root, entry);
    bytesByPath.set(entry.path, bytes);
    digest.update(entry.path, "utf8").update("\0").update(bytes).update("\0");
  }
  const rawTheme = parseThemeJson(bytesByPath.get("theme.json"));
  const manifestBytes = bytesByPath.get("content-manifest.json");
  let contentManifest;
  if (manifestBytes !== undefined) {
    let rawManifest;
    try {
      rawManifest = JSON.parse(decodeText(manifestBytes, "content-manifest.json"));
    } catch (error) {
      if (/content-manifest/.test(error?.message ?? "")) throw error;
      fail("content-manifest.json is not valid JSON");
    }
    contentManifest = await verifyContentManifest(before.root, rawManifest);
    const payloadPaths = before.files
      .map((entry) => entry.path)
      .filter((fileName) => fileName !== "content-manifest.json");
    if (contentManifest.files.length !== payloadPaths.length
        || contentManifest.files.some((entry, index) => entry.path !== payloadPaths[index])) {
      fail("Content manifest does not describe the exact installed theme files");
    }
  }
  const cssBytes = bytesByPath.get(rawTheme.styles ?? "theme.css");
  let safeCss = "";
  let safeCssRuntime = "";
  if (cssBytes !== undefined) {
    const validated = decodeAndValidateSafeCss(cssBytes);
    safeCss = validated.source;
    safeCssRuntime = validated.runtimeSource;
  }
  let sourceApiVersion;
  let theme;
  let legacyTheme;
  const declaredAssets = before.files
    .map((entry) => entry.path)
    .filter((fileName) => fileName !== "theme.json" && fileName !== "content-manifest.json");
  if (rawTheme.schemaVersion === 1) {
    sourceApiVersion = 1;
    legacyTheme = validateLegacyThemeDefinition(rawTheme);
    if (!entries.has(legacyTheme.image)) fail(`Installed v1 theme is missing ${legacyTheme.image}`);
    theme = adaptV1Theme(legacyTheme, { hasSafeCss: entries.has("theme.css") });
  } else if (rawTheme.schemaVersion === 2) {
    sourceApiVersion = 2;
    theme = validateThemeDefinition(rawTheme, declaredAssets);
  } else {
    fail("theme.json uses an unsupported Skin API version");
  }
  const after = await snapshotRegularFiles(before.root);
  if (!snapshotsEqual(before, after)) fail("Installed theme changed while it was being read");
  return deepFreeze({
    sourceApiVersion,
    theme: cloneJson(theme),
    ...(legacyTheme === undefined ? {} : { legacyTheme: cloneJson(legacyTheme) }),
    safeCss,
    safeCssRuntime,
    declaredFiles: before.files.map((entry) => entry.path)
      .filter((fileName) => fileName !== "content-manifest.json"),
    ...(contentManifest === undefined ? {} : { contentManifest: cloneJson(contentManifest) }),
    fingerprint: digest.digest("hex"),
  });
}
