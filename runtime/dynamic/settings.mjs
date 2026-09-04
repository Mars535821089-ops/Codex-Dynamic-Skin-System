import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const SETTING_KEYS = Object.freeze([
  "schemaVersion",
  "backgroundPlayback",
  "soundEnabled",
  "masterVolume",
  "ambientVolume",
  "uiVolume",
  "visualOpacity",
  "ambientMuted",
  "uiMuted",
  "quality",
  "reducedMotion",
  "hiddenAudio",
]);

const BOOLEAN_KEYS = Object.freeze([
  "backgroundPlayback",
  "soundEnabled",
  "ambientMuted",
  "uiMuted",
]);

const VOLUME_KEYS = Object.freeze([
  "masterVolume",
  "ambientVolume",
  "uiVolume",
  "visualOpacity",
]);

const ENUM_VALUES = Object.freeze({
  quality: Object.freeze(["auto", "full", "balanced", "media", "static"]),
  reducedMotion: Object.freeze(["system", "on", "off"]),
  hiddenAudio: Object.freeze(["pause", "continue"]),
});

export class DynamicSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DynamicSettingsError";
    this.code = code;
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_DYNAMIC_SETTINGS = deepFreeze({
  schemaVersion: 1,
  backgroundPlayback: true,
  soundEnabled: false,
  masterVolume: 1,
  ambientVolume: 0.7,
  uiVolume: 0.8,
  visualOpacity: 1,
  ambientMuted: false,
  uiMuted: false,
  quality: "auto",
  reducedMotion: "system",
  hiddenAudio: "pause",
});

function requirePlainObject(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DynamicSettingsError("VALUE_TYPE", "settings must be a plain object");
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DynamicSettingsError("VALUE_TYPE", "settings must be a plain object");
  }
}

function validateExactKeys(raw) {
  const allowed = new Set(SETTING_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new DynamicSettingsError("UNKNOWN_FIELD", `settings has unsupported field ${key}`);
    }
  }
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new DynamicSettingsError("MISSING_FIELD", `settings is missing required field ${key}`);
    }
  }
}

export function validateDynamicSettings(raw) {
  requirePlainObject(raw);
  validateExactKeys(raw);

  if (raw.schemaVersion !== 1) {
    throw new DynamicSettingsError(
      "SCHEMA_VERSION",
      `settings.schemaVersion must be 1, received ${String(raw.schemaVersion)}`,
    );
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] !== "boolean") {
      throw new DynamicSettingsError("VALUE_TYPE", `settings.${key} must be a boolean`);
    }
  }

  for (const key of VOLUME_KEYS) {
    const value = raw[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new DynamicSettingsError("VALUE_RANGE", `settings.${key} must be a finite number from 0 to 1`);
    }
  }

  for (const [key, values] of Object.entries(ENUM_VALUES)) {
    if (!values.includes(raw[key])) {
      throw new DynamicSettingsError(
        "VALUE_ENUM",
        `settings.${key} must be one of ${values.join(", ")}`,
      );
    }
  }

  const normalized = {};
  for (const key of SETTING_KEYS) {
    normalized[key] = raw[key];
  }
  return deepFreeze(normalized);
}

export function parseDynamicSettings(text) {
  if (typeof text !== "string") {
    return DEFAULT_DYNAMIC_SETTINGS;
  }
  try {
    const raw = JSON.parse(text);
    requirePlainObject(raw);
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
      return DEFAULT_DYNAMIC_SETTINGS;
    }
    const migrated = { ...DEFAULT_DYNAMIC_SETTINGS };
    for (const key of BOOLEAN_KEYS) {
      if (typeof raw[key] === "boolean") migrated[key] = raw[key];
    }
    for (const key of VOLUME_KEYS) {
      if (Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) migrated[key] = raw[key];
    }
    for (const [key, values] of Object.entries(ENUM_VALUES)) {
      if (values.includes(raw[key])) migrated[key] = raw[key];
    }
    return validateDynamicSettings(migrated);
  } catch {
    return DEFAULT_DYNAMIC_SETTINGS;
  }
}

export function serializeDynamicSettings(settings) {
  return `${JSON.stringify(validateDynamicSettings(settings), null, 2)}\n`;
}

async function lstatIfPresent(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateDestinationStat(stat, destination) {
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new DynamicSettingsError(
      "DESTINATION_SYMLINK",
      `refusing to write settings through symlink destination ${destination}`,
    );
  }
  if (!stat.isFile()) {
    throw new DynamicSettingsError(
      "DESTINATION_TYPE",
      `settings destination must be a regular file: ${destination}`,
    );
  }
}

async function syncDirectoryWhereSupported(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EISDIR", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function writeSettingsAtomically(destination, settings) {
  if (typeof destination !== "string" || destination.length === 0) {
    throw new DynamicSettingsError("DESTINATION_PATH", "settings destination must be a non-empty path");
  }

  const serialized = serializeDynamicSettings(settings);
  const requestedPath = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(requestedPath));
  const resolvedDestination = path.join(parent, path.basename(requestedPath));
  validateDestinationStat(await lstatIfPresent(resolvedDestination), resolvedDestination);

  const suffix = randomBytes(12).toString("hex");
  const temporaryPath = path.join(parent, `.${path.basename(resolvedDestination)}.${process.pid}.${suffix}.tmp`);
  let temporaryHandle;
  let renamed = false;

  try {
    temporaryHandle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await temporaryHandle.writeFile(serialized, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    validateDestinationStat(await lstatIfPresent(resolvedDestination), resolvedDestination);
    await fs.rename(temporaryPath, resolvedDestination);
    renamed = true;
    await syncDirectoryWhereSupported(parent);
  } finally {
    await temporaryHandle?.close();
    if (!renamed) {
      try {
        await fs.unlink(temporaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
