import { createHash } from "node:crypto";

import { collectThemeAssetPaths, validateThemeDefinition } from "./theme-contract.mjs";
import { validateDynamicSettings } from "./settings.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]*\.js$/;
const REVISION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const THEME_THUMBNAIL_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_THEME_THUMBNAIL_DATA_URL_LENGTH = 131_072;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export class DynamicPayloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DynamicPayloadError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DynamicPayloadError(code, message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("VALUE_TYPE", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("VALUE_TYPE", `${label} must be a plain object`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character]);
}

function normalizeLoadedSkin(loadedSkin) {
  plainObject(loadedSkin, "loadedSkin");
  if (![1, 2].includes(loadedSkin.sourceApiVersion)) {
    fail("SOURCE_API_VERSION", "loadedSkin.sourceApiVersion must be 1 or 2");
  }
  const declaredAssets = collectThemeAssetPaths(loadedSkin.theme);
  const theme = validateThemeDefinition(loadedSkin.theme, declaredAssets);
  return { sourceApiVersion: loadedSkin.sourceApiVersion, theme, declaredAssets };
}

function validateAssetUrl(value, asset, transport) {
  if (typeof value !== "string" || value.length > 2048) {
    fail("ASSET_URL", `asset URL for ${asset} must be a bounded string`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("ASSET_URL", `asset URL for ${asset} is invalid`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    fail("ASSET_URL", `asset URL for ${asset} must not contain credentials or a fragment`);
  }
  const deferred = parsed.protocol === "dream-skin-deferred:"
    && parsed.hostname === "asset" && parsed.pathname.length > 1;
  const loopback = parsed.protocol === "http:"
    && ["127.0.0.1", "[::1]"].includes(parsed.hostname)
    && parsed.port !== "";
  const rendererBlob = parsed.protocol === "blob:" && parsed.href.startsWith("blob:app:");
  const matchesTransport = transport === "deferred" ? deferred
    : transport === "loopback" ? loopback
      : transport === "renderer-blob" ? rendererBlob : false;
  if (!matchesTransport) {
    fail("ASSET_URL", `asset URL for ${asset} does not match ${transport} transport`);
  }
  return parsed.href;
}

function normalizeAssetTransport(assetTransport, assetUrls) {
  if (assetTransport !== undefined) {
    if (!["deferred", "loopback", "renderer-blob"].includes(assetTransport)) {
      fail("ASSET_TRANSPORT", "dynamic payload asset transport is invalid");
    }
    return assetTransport;
  }
  const values = Object.values(assetUrls ?? {});
  if (values.length > 0 && values.every((value) => typeof value === "string"
    && value.startsWith("dream-skin-deferred:"))) return "deferred";
  if (values.length > 0 && values.every((value) => typeof value === "string"
    && /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\//u.test(value))) return "loopback";
  fail("ASSET_TRANSPORT", "renderer blob assets require explicit renderer ownership");
}

function normalizeAssetUrls(assetUrls, expectedAssets, transport) {
  plainObject(assetUrls, "assetUrls");
  const received = Object.keys(assetUrls).sort();
  if (JSON.stringify(received) !== JSON.stringify(expectedAssets)) {
    fail("ASSET_URL_KEYS", "assetUrls keys must exactly match the normalized theme assets");
  }
  return Object.fromEntries(expectedAssets.map((asset) => [
    asset,
    validateAssetUrl(assetUrls[asset], asset, transport),
  ]));
}

function normalizeModules(modules) {
  if (!Array.isArray(modules) || modules.length < 2) {
    fail("MODULE_ORDER", "dynamic module bundle must contain registry and entry modules");
  }
  const names = modules.map((module) => module?.name);
  if (names[0] !== "module-registry.js" || names.at(-1) !== "entry.js"
    || new Set(names).size !== names.length
    || names.some((name) => typeof name !== "string" || !MODULE_NAME_PATTERN.test(name))) {
    fail("MODULE_ORDER", "dynamic module bundle has an invalid or duplicate module order");
  }
  let totalBytes = 0;
  return modules.map((module, index) => {
    plainObject(module, `modules[${index}]`);
    if (Object.keys(module).sort().join(",") !== "name,sha256,source") {
      fail("MODULE_FIELDS", `modules[${index}] must contain only name, sha256, and source`);
    }
    if (typeof module.source !== "string" || module.source.length === 0 || module.source.includes("\0")) {
      fail("MODULE_SOURCE", `module ${module.name} source is invalid`);
    }
    const bytes = Buffer.byteLength(module.source, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_MODULE_BYTES || totalBytes > MAX_BUNDLE_BYTES) {
      fail("MODULE_SIZE", "dynamic module bundle exceeds its size limit");
    }
    const actual = createHash("sha256").update(module.source, "utf8").digest("hex");
    if (!SHA256_PATTERN.test(module.sha256) || module.sha256 !== actual) {
      fail("MODULE_HASH", `module ${module.name} does not match its SHA-256 digest`);
    }
    return { name: module.name, sha256: module.sha256, source: module.source };
  });
}

function normalizeThemeCatalog(themeCatalog, currentThemeId) {
  if (themeCatalog === undefined) return [];
  if (!Array.isArray(themeCatalog) || themeCatalog.length > 128) {
    fail("THEME_CATALOG", "themeCatalog must be an array with at most 128 entries");
  }
  const ids = new Set();
  const normalized = themeCatalog.map((entry, index) => {
    try { plainObject(entry, `themeCatalog[${index}]`); } catch {
      fail("THEME_CATALOG", `themeCatalog[${index}] must be a plain object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.some((key) => !["hasAudio", "id", "kind", "name", "thumbnail"].includes(key))
      || !keys.includes("id") || !keys.includes("name")
      || typeof entry.id !== "string" || !THEME_ID_PATTERN.test(entry.id)
      || entry.id.length > 128 || typeof entry.name !== "string"
      || entry.name.trim().length < 1 || Array.from(entry.name.trim()).length > 80
      || /[\u0000-\u001f\u007f]/u.test(entry.name)
      || (entry.kind !== undefined && !["image", "video", "builtin-effect"].includes(entry.kind))
      || (entry.hasAudio !== undefined && typeof entry.hasAudio !== "boolean")
      || (entry.thumbnail !== undefined && (typeof entry.thumbnail !== "string"
        || entry.thumbnail.length > MAX_THEME_THUMBNAIL_DATA_URL_LENGTH
        || !THEME_THUMBNAIL_PATTERN.test(entry.thumbnail)))) {
      fail("THEME_CATALOG", `themeCatalog[${index}] is invalid`);
    }
    if (ids.has(entry.id)) fail("THEME_CATALOG", `themeCatalog contains duplicate id ${entry.id}`);
    ids.add(entry.id);
    return {
      id: entry.id,
      name: entry.name.trim().normalize("NFC"),
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.hasAudio === undefined ? {} : { hasAudio: entry.hasAudio }),
      ...(entry.thumbnail === undefined ? {} : { thumbnail: entry.thumbnail }),
    };
  });
  if (normalized.length && !ids.has(currentThemeId)) {
    fail("THEME_CATALOG", "themeCatalog must contain the active theme");
  }
  return normalized;
}

function normalizeThemeStorage(storage) {
  if (storage === undefined) return undefined;
  try { plainObject(storage, "storage"); } catch {
    fail("THEME_STORAGE", "storage must be a plain object");
  }
  // This path is display metadata, not a file URL. Validate both platforms
  // independently of the host running the composer (including portable tests).
  const absolutePath = typeof storage.path === "string" && (
    storage.path.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(storage.path)
    || /^\\\\[^\\/?\.][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/u.test(storage.path)
  );
  if (Object.keys(storage).sort().join(",") !== "available,bytes,custom,path,themeCount"
    || !absolutePath
    || storage.path.length > 2048 || /[\u0000-\u001f\u007f]/u.test(storage.path)
    || typeof storage.available !== "boolean" || typeof storage.custom !== "boolean"
    || !Number.isSafeInteger(storage.bytes) || storage.bytes < 0
    || !Number.isSafeInteger(storage.themeCount) || storage.themeCount < 0 || storage.themeCount > 10_000) {
    fail("THEME_STORAGE", "storage status is invalid");
  }
  return { path: storage.path, available: storage.available, custom: storage.custom,
    bytes: storage.bytes, themeCount: storage.themeCount };
}

export function composeDynamicPayload({ loadedSkin, settings, assetUrls, revision, modules,
  activation = "deferred", assetTransport, themeCatalog, storage,
  displayMode = "theme", settingsAuthority = "renderer-local",
  backgroundPlaybackSupport = "restart-required" } = {}) {
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    fail("REVISION", "dynamic payload revision is invalid");
  }
  const normalizedSkin = normalizeLoadedSkin(loadedSkin);
  const normalizedSettings = validateDynamicSettings(settings);
  const normalizedTransport = normalizeAssetTransport(assetTransport, assetUrls);
  const normalizedAssets = normalizeAssetUrls(
    assetUrls, normalizedSkin.declaredAssets, normalizedTransport,
  );
  const normalizedModules = normalizeModules(modules);
  const normalizedThemeCatalog = normalizeThemeCatalog(themeCatalog, normalizedSkin.theme.id);
  const normalizedStorage = normalizeThemeStorage(storage);
  if (!["renderer-local", "shared-file"].includes(settingsAuthority)) {
    fail("SETTINGS_AUTHORITY", "dynamic settings authority is invalid");
  }
  if (!["deferred", "active"].includes(activation)) {
    fail("ACTIVATION", "dynamic payload activation mode is invalid");
  }
  if (!["theme", "native"].includes(displayMode)) {
    fail("DISPLAY_MODE", "dynamic payload display mode is invalid");
  }
  if (!["supported", "restart-required"].includes(backgroundPlaybackSupport)) {
    fail("BACKGROUND_PLAYBACK_SUPPORT", "background playback support state is invalid");
  }
  const config = deepFreeze({
    protocolVersion: 1,
    generation: revision,
    activation,
    displayMode,
    assetTransport: normalizedTransport,
    theme: normalizedSkin.theme,
    themeCatalog: normalizedThemeCatalog,
    ...(normalizedStorage === undefined ? {} : { storage: normalizedStorage }),
    backgroundPlaybackSupport,
    sourceApiVersion: normalizedSkin.sourceApiVersion,
    settingsAuthority,
    settings: normalizedSettings,
    assets: normalizedAssets,
    moduleHashes: normalizedModules.map(({ name, sha256 }) => ({ name, sha256 })),
  });
  const source = `;${normalizedModules.map(({ source: moduleSource }) => moduleSource).join("\n")}\n`
    + `;globalThis.__startCodexDynamicSkin(${safeJson(config)});`;
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  return deepFreeze({ source, sha256, config });
}
