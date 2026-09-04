#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { importMediaTheme } from "./theme-library-actions.mjs";
import { readThemeStoragePreference } from "./theme-storage-actions.mjs";

const SCHEMA_VERSION = 1;

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireSafeText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || /[\0-\x1f\x7f]/.test(value) || value.length > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `${label} is invalid`);
  }
  return value.trim();
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--file", "--name", "--source-id", "--state-root"]).has(key) || value === undefined) {
      throw new BridgeError("INVALID_ARGUMENT", `Unknown or incomplete argument: ${key ?? "<missing>"}`);
    }
    if (values.has(key)) throw new BridgeError("INVALID_ARGUMENT", `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const sourcePath = requireSafeText(values.get("--file"), "Media file", 4096);
  if (!path.isAbsolute(sourcePath)) throw new BridgeError("INVALID_ARGUMENT", "Media file must be an absolute path");
  const themeName = requireSafeText(values.get("--name"), "Theme name", 256);
  const sourceId = values.has("--source-id")
    ? requireSafeText(values.get("--source-id"), "Source ID", 256)
    : null;
  const stateRoot = values.has("--state-root")
    ? requireSafeText(values.get("--state-root"), "State root", 4096)
    : path.join(os.homedir(), "Library", "Application Support", "CodexDreamSkinStudio");
  if (!path.isAbsolute(stateRoot)) throw new BridgeError("INVALID_ARGUMENT", "State root must be an absolute path");
  return { sourcePath: path.resolve(sourcePath), themeName, sourceId, stateRoot: path.resolve(stateRoot) };
}

export async function importFromArguments(argv) {
  const { sourcePath, themeName, stateRoot } = parseArguments(argv);
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const defaultLibrary = path.join(stateRoot, "themes");
  const preferencePath = path.join(stateRoot, "theme-storage.json");
  try {
    await fs.access(preferencePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(defaultLibrary, { recursive: true, mode: 0o700 });
  }
  const preference = await readThemeStoragePreference(
    preferencePath,
    defaultLibrary,
  );
  if (!preference.available || !preference.root) {
    throw new BridgeError(
      "THEME_LIBRARY_UNAVAILABLE",
      `Configured theme library is unavailable: ${preference.configuredRoot}`,
    );
  }
  const imported = await importMediaTheme({
    libraryRoot: preference.root,
    sourcePath,
    themeName,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    status: imported.duplicate ? "duplicate" : "imported",
    themeId: imported.themeId,
    themeDir: imported.themeDir,
    media: imported.media,
  };
}

function errorPayload(error) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "error",
    code: error?.code || "IMPORT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(`${JSON.stringify(await importFromArguments(argv))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
