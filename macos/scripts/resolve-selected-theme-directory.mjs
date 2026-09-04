#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { readThemeSelection, themeSelectionPath } from "./theme-selection-store.mjs";
import { readThemeStoragePreference, themeStoragePreferencePath } from "./theme-storage-actions.mjs";

const CLIENT_OPTIONS = Object.freeze({ platform: "macos", clientVersion: "2.0.0" });

async function matchingThemeDirectory(libraryRoot, themeId) {
  const rootStat = await fs.lstat(libraryRoot);
  if (rootStat.isSymbolicLink()) throw new Error("Theme library root must not be a symbolic link");
  if (!rootStat.isDirectory()) throw new Error("Theme library root must be a directory");
  const realRoot = await fs.realpath(libraryRoot);
  let match = null;
  for (const child of await fs.readdir(realRoot, { withFileTypes: true })) {
    if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith(".")) continue;
    const candidate = path.join(realRoot, child.name);
    try {
      const realCandidate = await fs.realpath(candidate);
      if (path.dirname(realCandidate) !== realRoot) continue;
      const loaded = await loadInstalledSkin(realCandidate, CLIENT_OPTIONS);
      if (loaded.sourceApiVersion !== 2 || loaded.theme.id !== themeId) continue;
      if (match) throw new Error(`Selected theme id is duplicated: ${themeId}`);
      match = realCandidate;
    } catch (error) {
      if (error?.message?.startsWith("Selected theme id is duplicated:")) throw error;
    }
  }
  return match;
}

export async function resolveSelectedThemeDirectory({
  fallbackThemeDir,
  defaultThemeLibrary,
  settingsPath,
}) {
  const fallback = await fs.realpath(fallbackThemeDir);
  const selectionFile = themeSelectionPath({ settingsPath, themeLibrary: defaultThemeLibrary });
  const selection = await readThemeSelection(selectionFile);
  if (!selection) return fallback;
  const preference = await readThemeStoragePreference(
    themeStoragePreferencePath({ settingsPath, themeLibrary: defaultThemeLibrary }),
    defaultThemeLibrary,
  );
  if (!preference.available || !preference.root) return fallback;
  return await matchingThemeDirectory(preference.root, selection.themeId) ?? fallback;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--fallback-theme-dir", "--default-theme-library", "--settings"]).has(key)
      || value === undefined || values.has(key)) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${key ?? "<missing>"}`);
    }
    values.set(key, value);
  }
  for (const required of ["--fallback-theme-dir", "--default-theme-library", "--settings"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    fallbackThemeDir: values.get("--fallback-theme-dir"),
    defaultThemeLibrary: values.get("--default-theme-library"),
    settingsPath: values.get("--settings"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${await resolveSelectedThemeDirectory(parseArguments(argv))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
