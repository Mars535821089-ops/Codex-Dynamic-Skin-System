#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SKIN_API_VERSION = 2;

export const THEME_LIMITS = Object.freeze({
  zipCompressedBytes: 128 * 1024 * 1024,
  zipExpandedBytes: 256 * 1024 * 1024,
  zipEntries: 64,
  singleEntryBytes: 96 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  imageDimension: 8192,
  imagePixels: 40_000_000,
  videoBytes: 96 * 1024 * 1024,
  videoSeconds: 60,
  videoWidth: 3840,
  videoHeight: 2160,
  videoFps: 60,
  ambientBytes: 32 * 1024 * 1024,
  ambientSeconds: 15 * 60,
  uiClipBytes: 2 * 1024 * 1024,
  uiClipSeconds: 10,
  uiClipCount: 32,
  textBytes: 256 * 1024,
});

export const THEME_CAPABILITIES = Object.freeze([
  "safe-css",
  "animated-background",
  "sound-pack",
  "builtin-effect",
]);

export const SEMANTIC_UI_EVENTS = Object.freeze([
  "taskCompleted",
  "approvalRequested",
  "taskFailed",
]);

export const BUILTIN_EFFECTS = Object.freeze(["voxel-field"]);

const ROOT_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "version",
  "capabilities",
  "visual",
  "audio",
  "effect",
  "styles",
  "tokens",
];
const TOKEN_KEYS = ["background", "panel", "accent", "accentAlt", "text", "muted", "line"];
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const ASSET_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u;
const WINDOWS_DEVICE_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const textEncoder = new TextEncoder();

export class ThemeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ThemeContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ThemeContractError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail("TYPE", `${label} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, label, required = []) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", `${label} is missing ${key}`);
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("UNKNOWN_FIELD", `${label} contains unsupported field ${key}`);
  }
}

function assertString(value, label, { min = 0, max, pattern } = {}) {
  if (typeof value !== "string") fail("TYPE", `${label} must be a string`);
  const normalized = value.normalize("NFC");
  const length = Array.from(normalized).length;
  if (CONTROL_PATTERN.test(normalized) || length < min || (max !== undefined && length > max)) {
    fail("VALUE_RANGE", `${label} has an invalid length or control characters`);
  }
  if (pattern && !pattern.test(normalized)) fail("VALUE_FORMAT", `${label} has an invalid format`);
  return normalized;
}

function assertBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("TYPE", `${label} must be boolean`);
  return value;
}

function assertNumber(value, label, { min, max, fallback, integer = false }) {
  const selected = value === undefined ? fallback : value;
  if (
    typeof selected !== "number"
    || !Number.isFinite(selected)
    || (integer && !Number.isInteger(selected))
    || selected < min
    || selected > max
  ) fail("VALUE_RANGE", `${label} must be between ${min} and ${max}`);
  return selected;
}

function assertChoice(value, label, allowed, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!allowed.includes(selected)) fail("VALUE_FORMAT", `${label} is unsupported`);
  return selected;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalAssetPath(value) {
  if (typeof value !== "string") {
    fail("ASSET_PATH", "Asset path must be a canonical relative package path");
  }
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0
    || normalized.length > 240
    || textEncoder.encode(normalized).length > 512
    || CONTROL_PATTERN.test(normalized)
    || normalized.startsWith("/")
    || normalized.includes("\\")
    || normalized.includes(":")
    || normalized.includes("//")
  ) fail("ASSET_PATH", `${value} is not a canonical relative package path`);
  const segments = normalized.split("/");
  if (
    segments.some((segment) => (
      segment === "."
      || segment === ".."
      || !ASSET_SEGMENT_PATTERN.test(segment)
      || segment.endsWith(".")
      || WINDOWS_DEVICE_PATTERN.test(segment)
    ))
  ) fail("ASSET_PATH", `${value} is not a canonical relative package path`);
  return segments.join("/");
}

function normalizeDeclaredAssets(declaredAssets) {
  if (declaredAssets == null || typeof declaredAssets[Symbol.iterator] !== "function") {
    fail("TYPE", "declaredAssets must be an iterable of package paths");
  }
  const canonical = new Set();
  const folded = new Map();
  for (const rawPath of declaredAssets) {
    const assetPath = canonicalAssetPath(rawPath);
    if (rawPath !== assetPath) fail("ASSET_PATH", `${rawPath} is not a canonical relative package path`);
    if (canonical.has(assetPath)) fail("ASSET_COLLISION", `Declared assets repeat ${assetPath}`);
    const collisionKey = assetPath.toLowerCase();
    const previous = folded.get(collisionKey);
    if (previous !== undefined) {
      fail("ASSET_COLLISION", `Declared assets contain a case-fold collision: ${previous} and ${assetPath}`);
    }
    canonical.add(assetPath);
    folded.set(collisionKey, assetPath);
  }
  return canonical;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length > THEME_CAPABILITIES.length) {
    fail("TYPE", "theme.capabilities must be an array of supported values");
  }
  const selected = new Set();
  for (const capability of value) {
    if (!THEME_CAPABILITIES.includes(capability)) {
      fail("VALUE_FORMAT", `theme.capabilities contains unsupported value ${String(capability)}`);
    }
    if (selected.has(capability)) fail("VALUE_FORMAT", `theme.capabilities repeats ${capability}`);
    selected.add(capability);
  }
  return THEME_CAPABILITIES.filter((capability) => selected.has(capability));
}

function normalizeVisual(value) {
  const visual = assertObject(value, "theme.visual");
  const kind = assertChoice(visual.kind, "theme.visual.kind", ["image", "video", "builtin-effect"]);
  if (kind === "image") {
    assertExactKeys(visual, ["kind", "asset", "fit", "opacity"], "theme.visual", ["kind", "asset"]);
    return {
      kind,
      asset: canonicalAssetPath(visual.asset),
      fit: assertChoice(visual.fit, "theme.visual.fit", ["cover", "contain", "adaptive"], "cover"),
      opacity: assertNumber(visual.opacity, "theme.visual.opacity", { min: 0, max: 1, fallback: 1 }),
    };
  }
  if (kind === "video") {
    assertExactKeys(
      visual,
      ["kind", "asset", "poster", "fit", "opacity", "overscan", "loop"],
      "theme.visual",
      ["kind", "asset"],
    );
    return {
      kind,
      asset: canonicalAssetPath(visual.asset),
      ...(visual.poster === undefined ? {} : { poster: canonicalAssetPath(visual.poster) }),
      fit: assertChoice(visual.fit, "theme.visual.fit", ["cover", "contain", "adaptive"], "cover"),
      opacity: assertNumber(visual.opacity, "theme.visual.opacity", { min: 0, max: 1, fallback: 1 }),
      overscan: assertNumber(visual.overscan, "theme.visual.overscan", { min: 1, max: 1.25, fallback: 1 }),
      loop: assertBoolean(visual.loop, "theme.visual.loop", true),
    };
  }
  assertExactKeys(
    visual,
    ["kind", "effect", "fallback", "fit", "opacity"],
    "theme.visual",
    ["kind", "effect", "fallback"],
  );
  const fallback = assertObject(visual.fallback, "theme.visual.fallback");
  assertExactKeys(fallback, ["video", "poster"], "theme.visual.fallback", ["poster"]);
  return {
    kind,
    effect: assertChoice(visual.effect, "theme.visual.effect", BUILTIN_EFFECTS),
    fallback: {
      ...(fallback.video === undefined ? {} : { video: canonicalAssetPath(fallback.video) }),
      poster: canonicalAssetPath(fallback.poster),
    },
    fit: assertChoice(visual.fit, "theme.visual.fit", ["cover", "contain", "adaptive"], "cover"),
    opacity: assertNumber(visual.opacity, "theme.visual.opacity", { min: 0, max: 1, fallback: 1 }),
  };
}

function normalizeAmbient(value = { source: "none" }) {
  const ambient = assertObject(value, "theme.audio.ambient");
  assertExactKeys(
    ambient,
    ["source", "asset", "loop", "volume", "analyze"],
    "theme.audio.ambient",
    ["source"],
  );
  const source = assertChoice(ambient.source, "theme.audio.ambient.source", ["visual", "asset", "none"]);
  if (source === "asset" && ambient.asset === undefined) {
    fail("MISSING_FIELD", "theme.audio.ambient is missing asset for source asset");
  }
  if (source !== "asset" && ambient.asset !== undefined) {
    fail("AUDIO_SOURCE", `theme.audio.ambient.asset is not allowed for source ${source}`);
  }
  const analyze = assertBoolean(ambient.analyze, "theme.audio.ambient.analyze", source !== "none");
  if (source === "none" && analyze) fail("AUDIO_SOURCE", "Ambient source none cannot enable analysis");
  return {
    source,
    ...(source === "asset" ? { asset: canonicalAssetPath(ambient.asset) } : {}),
    loop: assertBoolean(ambient.loop, "theme.audio.ambient.loop", true),
    volume: assertNumber(ambient.volume, "theme.audio.ambient.volume", { min: 0, max: 1, fallback: 0.7 }),
    analyze,
  };
}

function normalizeUiAudio(value = {}) {
  const ui = assertObject(value, "theme.audio.ui");
  assertExactKeys(ui, ["volume", "events"], "theme.audio.ui", ["events"]);
  const events = assertObject(ui.events, "theme.audio.ui.events");
  assertExactKeys(events, SEMANTIC_UI_EVENTS, "theme.audio.ui.events");
  const normalizedEvents = {};
  for (const eventName of SEMANTIC_UI_EVENTS) {
    if (events[eventName] !== undefined) {
      normalizedEvents[eventName] = canonicalAssetPath(events[eventName]);
    }
  }
  if (Object.keys(normalizedEvents).length > THEME_LIMITS.uiClipCount) {
    fail("VALUE_RANGE", `theme.audio.ui.events exceeds ${THEME_LIMITS.uiClipCount} clips`);
  }
  return {
    volume: assertNumber(ui.volume, "theme.audio.ui.volume", { min: 0, max: 1, fallback: 0.8 }),
    events: normalizedEvents,
  };
}

function normalizeAudio(value) {
  const audio = assertObject(value, "theme.audio");
  assertExactKeys(audio, ["ambient", "ui"], "theme.audio", ["ambient", "ui"]);
  return {
    ambient: normalizeAmbient(audio.ambient),
    ui: normalizeUiAudio(audio.ui),
  };
}

function normalizeEffect(value, visual, audio) {
  if (visual.kind !== "builtin-effect") {
    if (value !== undefined) fail("CAPABILITY_MISMATCH", "theme.effect requires a builtin-effect visual");
    return undefined;
  }
  const effect = assertObject(value, "theme.effect");
  assertExactKeys(effect, ["id", "source", "parameters"], "theme.effect", ["id", "source"]);
  const id = assertChoice(effect.id, "theme.effect.id", BUILTIN_EFFECTS);
  if (id !== visual.effect) fail("CAPABILITY_MISMATCH", "theme.visual.effect must match theme.effect.id");
  const source = assertChoice(effect.source, "theme.effect.source", ["ambient", "none"]);
  if (source === "ambient" && (audio.ambient.source === "none" || !audio.ambient.analyze)) {
    fail("AUDIO_SOURCE", "An ambient-driven effect requires analyzable ambient audio");
  }
  const parameters = assertObject(effect.parameters ?? {}, "theme.effect.parameters");
  assertExactKeys(
    parameters,
    ["gridSize", "height", "smoothing", "bloom", "palette"],
    "theme.effect.parameters",
  );
  const palette = parameters.palette ?? ["#8b5cf6", "#22d3ee", "#f472b6"];
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 8) {
    fail("VALUE_RANGE", "theme.effect.parameters.palette must contain between 2 and 8 colors");
  }
  return {
    id,
    source,
    parameters: {
      gridSize: assertNumber(parameters.gridSize, "theme.effect.parameters.gridSize", {
        min: 8, max: 64, fallback: 48, integer: true,
      }),
      height: assertNumber(parameters.height, "theme.effect.parameters.height", {
        min: 0.1, max: 8, fallback: 3.2,
      }),
      smoothing: assertNumber(parameters.smoothing, "theme.effect.parameters.smoothing", {
        min: 0, max: 0.98, fallback: 0.72,
      }),
      bloom: assertNumber(parameters.bloom, "theme.effect.parameters.bloom", {
        min: 0, max: 1, fallback: 0.35,
      }),
      palette: palette.map((color, index) => assertString(
        color,
        `theme.effect.parameters.palette[${index}]`,
        { min: 7, max: 9, pattern: HEX_COLOR_PATTERN },
      )),
    },
  };
}

function normalizeTokens(value) {
  if (value === undefined) return {};
  const tokens = assertObject(value, "theme.tokens");
  assertExactKeys(tokens, TOKEN_KEYS, "theme.tokens");
  const result = {};
  for (const key of TOKEN_KEYS) {
    if (tokens[key] !== undefined) {
      result[key] = assertString(tokens[key], `theme.tokens.${key}`, {
        min: 7,
        max: 9,
        pattern: HEX_COLOR_PATTERN,
      });
    }
  }
  return result;
}

function assertCapabilityConsistency(theme) {
  const capabilities = new Set(theme.capabilities);
  const hasUiAudio = Object.keys(theme.audio.ui.events).length > 0;
  const hasSound = theme.audio.ambient.source !== "none" || hasUiAudio;
  const checks = [
    ["safe-css", theme.styles !== undefined],
    ["animated-background", theme.visual.kind !== "image"],
    ["sound-pack", hasSound],
    ["builtin-effect", theme.visual.kind === "builtin-effect"],
  ];
  for (const [capability, required] of checks) {
    if (capabilities.has(capability) !== required) {
      fail("CAPABILITY_MISMATCH", `${capability} capability does not match the theme definition`);
    }
  }
  if (theme.audio.ambient.source === "visual") {
    const video = theme.visual.kind === "video"
      ? theme.visual.asset
      : theme.visual.kind === "builtin-effect" ? theme.visual.fallback.video : undefined;
    if (video === undefined) {
      fail("AUDIO_SOURCE", "Ambient source visual requires a declared video with an embedded audio track");
    }
  }
}

export function collectThemeAssetPaths(theme) {
  const assets = new Set();
  if (theme.visual.kind === "image" || theme.visual.kind === "video") assets.add(theme.visual.asset);
  if (theme.visual.kind === "video" && theme.visual.poster !== undefined) assets.add(theme.visual.poster);
  if (theme.visual.kind === "builtin-effect") {
    if (theme.visual.fallback.video !== undefined) assets.add(theme.visual.fallback.video);
    assets.add(theme.visual.fallback.poster);
  }
  if (theme.audio.ambient.source === "asset") assets.add(theme.audio.ambient.asset);
  for (const asset of Object.values(theme.audio.ui.events)) assets.add(asset);
  if (theme.styles !== undefined) assets.add(theme.styles);
  return [...assets].sort();
}

export function validateThemeDefinition(raw, declaredAssets) {
  const theme = assertObject(raw, "theme");
  assertExactKeys(theme, ROOT_KEYS, "theme", [
    "schemaVersion",
    "id",
    "name",
    "version",
    "capabilities",
    "visual",
    "audio",
  ]);
  if (theme.schemaVersion !== SKIN_API_VERSION) {
    fail("SCHEMA_VERSION", `theme.schemaVersion must be ${SKIN_API_VERSION}`);
  }
  const declared = normalizeDeclaredAssets(declaredAssets);
  const visual = normalizeVisual(theme.visual);
  const audio = normalizeAudio(theme.audio);
  const normalized = {
    schemaVersion: SKIN_API_VERSION,
    id: assertString(theme.id, "theme.id", { min: 3, max: 128, pattern: THEME_ID_PATTERN }),
    name: assertString(theme.name, "theme.name", { min: 1, max: 80 }),
    version: assertString(theme.version, "theme.version", { min: 5, max: 64, pattern: SEMVER_PATTERN }),
    capabilities: normalizeCapabilities(theme.capabilities),
    visual,
    audio,
    ...(theme.effect === undefined && visual.kind !== "builtin-effect"
      ? {}
      : { effect: normalizeEffect(theme.effect, visual, audio) }),
    ...(theme.styles === undefined ? {} : { styles: canonicalAssetPath(theme.styles) }),
    tokens: normalizeTokens(theme.tokens),
  };
  if (normalized.styles !== undefined && path.posix.extname(normalized.styles).toLowerCase() !== ".css") {
    fail("ASSET_ROLE", "theme.styles must reference a .css file");
  }
  assertCapabilityConsistency(normalized);
  for (const assetPath of collectThemeAssetPaths(normalized)) {
    if (!declared.has(assetPath)) fail("UNDECLARED_ASSET", `Theme references undeclared asset ${assetPath}`);
  }
  return deepFreeze(normalized);
}

export const THEME_CONTRACT_DOCUMENT = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-dynamic-skin.local/schema/theme-v2.json",
  title: "Codex Dynamic Skin Theme v2",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name", "version", "capabilities", "visual", "audio"],
  properties: {
    schemaVersion: { const: 2 },
    id: { type: "string", minLength: 3, maxLength: 128, pattern: THEME_ID_PATTERN.source },
    name: { type: "string", minLength: 1, maxLength: 80 },
    version: { type: "string", minLength: 5, maxLength: 64, pattern: SEMVER_PATTERN.source },
    capabilities: {
      type: "array",
      uniqueItems: true,
      maxItems: THEME_CAPABILITIES.length,
      items: { enum: [...THEME_CAPABILITIES] },
    },
    visual: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "asset"],
          properties: {
            kind: { const: "image" },
            asset: { type: "string", minLength: 1, maxLength: 240 },
            fit: { enum: ["cover", "contain", "adaptive"] },
            opacity: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "asset"],
          properties: {
            kind: { const: "video" },
            asset: { type: "string", minLength: 1, maxLength: 240 },
            poster: { type: "string", minLength: 1, maxLength: 240 },
            fit: { enum: ["cover", "contain", "adaptive"] },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            overscan: { type: "number", minimum: 1, maximum: 1.25 },
            loop: { type: "boolean" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "effect", "fallback"],
          properties: {
            kind: { const: "builtin-effect" },
            effect: { enum: [...BUILTIN_EFFECTS] },
            fallback: {
              type: "object",
              additionalProperties: false,
              required: ["poster"],
              properties: {
                video: { type: "string", minLength: 1, maxLength: 240 },
                poster: { type: "string", minLength: 1, maxLength: 240 },
              },
            },
            fit: { enum: ["cover", "contain", "adaptive"] },
            opacity: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      ],
    },
    audio: {
      type: "object",
      additionalProperties: false,
      required: ["ambient", "ui"],
      properties: {
        ambient: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: {
            source: { enum: ["visual", "asset", "none"] },
            asset: { type: "string", minLength: 1, maxLength: 240 },
            loop: { type: "boolean" },
            volume: { type: "number", minimum: 0, maximum: 1 },
            analyze: { type: "boolean" },
          },
        },
        ui: {
          type: "object",
          additionalProperties: false,
          required: ["events"],
          properties: {
            volume: { type: "number", minimum: 0, maximum: 1 },
            events: {
              type: "object",
              additionalProperties: false,
              properties: Object.fromEntries(
                SEMANTIC_UI_EVENTS.map((eventName) => [
                  eventName,
                  { type: "string", minLength: 1, maxLength: 240 },
                ]),
              ),
            },
          },
        },
      },
    },
    effect: {
      type: "object",
      additionalProperties: false,
      required: ["id", "source"],
      properties: {
        id: { enum: [...BUILTIN_EFFECTS] },
        source: { enum: ["ambient", "none"] },
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            gridSize: { type: "integer", minimum: 8, maximum: 64 },
            height: { type: "number", minimum: 0.1, maximum: 8 },
            smoothing: { type: "number", minimum: 0, maximum: 0.98 },
            bloom: { type: "number", minimum: 0, maximum: 1 },
            palette: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: { type: "string", pattern: HEX_COLOR_PATTERN.source },
            },
          },
        },
      },
    },
    styles: { type: "string" },
    tokens: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        TOKEN_KEYS.map((tokenName) => [
          tokenName,
          { type: "string", pattern: HEX_COLOR_PATTERN.source },
        ]),
      ),
    },
  },
  "x-semanticUiEvents": [...SEMANTIC_UI_EVENTS],
  "x-builtinEffects": [...BUILTIN_EFFECTS],
  "x-limits": { ...THEME_LIMITS },
});

export function serializeThemeContract() {
  return `${JSON.stringify(THEME_CONTRACT_DOCUMENT, null, 2)}\n`;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  if (process.argv.length === 3 && process.argv[2] === "--print-contract") {
    process.stdout.write(serializeThemeContract());
  } else {
    process.stderr.write("Usage: theme-contract.mjs --print-contract\n");
    process.exitCode = 2;
  }
}
