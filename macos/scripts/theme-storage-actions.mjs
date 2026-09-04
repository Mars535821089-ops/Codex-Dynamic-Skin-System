import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";

const execFileAsync = promisify(execFile);
const CLIENT_OPTIONS = Object.freeze({ platform: "macos", clientVersion: "2.0.0" });

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function existingDirectory(requested, label) {
  const absolute = path.resolve(requested);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  return fs.realpath(absolute);
}

async function optionalDirectory(requested) {
  try {
    return await existingDirectory(requested, "Theme library");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function themeStoragePreferencePath({ settingsPath = null, themeLibrary }) {
  const anchor = settingsPath ? path.dirname(path.resolve(settingsPath)) : path.dirname(path.resolve(themeLibrary));
  return path.join(anchor, "theme-storage.json");
}

export async function readThemeStoragePreference(preferencePath, fallbackRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(preferencePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const fallback = await existingDirectory(fallbackRoot, "Default theme library");
    return { root: fallback, configuredRoot: fallback, available: true, custom: false };
  }
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.libraryRoot !== "string"
    || !path.isAbsolute(parsed.libraryRoot) || /[\0-\x1f\x7f]/.test(parsed.libraryRoot)
    || parsed.libraryRoot.length > 2048) {
    throw new Error("Theme storage preference is invalid");
  }
  const configuredRoot = path.resolve(parsed.libraryRoot);
  const root = await optionalDirectory(configuredRoot);
  return { root, configuredRoot: root ?? configuredRoot, available: Boolean(root), custom: true };
}

export async function writeThemeStoragePreference(preferencePath, libraryRoot) {
  const root = await existingDirectory(libraryRoot, "Theme library");
  const parent = path.dirname(path.resolve(preferencePath));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.theme-storage-${process.pid}-${randomBytes(5).toString("hex")}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, libraryRoot: root }, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    });
    await fs.rename(temporary, preferencePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return root;
}

async function walkStorage(root) {
  let bytes = 0;
  let entries = 0;
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 100_000) throw new Error("Theme storage contains too many files");
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile()) bytes += (await fs.stat(candidate)).size;
    }
  }
  return bytes;
}

export async function inspectThemeStorage(libraryRoot) {
  if (!libraryRoot) return { path: null, available: false, bytes: 0, themeCount: 0 };
  let root;
  try {
    root = await existingDirectory(libraryRoot, "Theme library");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: path.resolve(libraryRoot), available: false, bytes: 0, themeCount: 0 };
    }
    throw error;
  }
  let themeCount = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    try {
      const loaded = await loadInstalledSkin(path.join(root, entry.name), CLIENT_OPTIONS);
      if (loaded.sourceApiVersion === 2) themeCount += 1;
    } catch {}
  }
  return { path: root, available: true, bytes: await walkStorage(root), themeCount };
}

async function copyAndValidateTheme(source, destinationRoot) {
  const sourceLoaded = await loadInstalledSkin(source, CLIENT_OPTIONS);
  if (sourceLoaded.sourceApiVersion !== 2) throw new Error(`Theme ${path.basename(source)} is not Skin API v2`);
  const destination = path.join(destinationRoot, path.basename(source));
  const existing = await fs.lstat(destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Theme migration conflict at ${destination}`);
    const loaded = await loadInstalledSkin(destination, CLIENT_OPTIONS).catch(() => null);
    if (!loaded || loaded.theme.id !== sourceLoaded.theme.id || loaded.fingerprint !== sourceLoaded.fingerprint) {
      throw new Error(`Theme migration conflict at ${destination}`);
    }
    return { themeId: sourceLoaded.theme.id, source, destination: await fs.realpath(destination),
      fingerprint: sourceLoaded.fingerprint, copied: false };
  }
  const stage = path.join(destinationRoot, `.migrate-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fs.cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    const copied = await loadInstalledSkin(stage, CLIENT_OPTIONS);
    if (copied.theme.id !== sourceLoaded.theme.id || copied.fingerprint !== sourceLoaded.fingerprint) {
      throw new Error(`Theme migration validation failed for ${sourceLoaded.theme.id}`);
    }
    await fs.rename(stage, destination);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
  return { themeId: sourceLoaded.theme.id, source, destination: await fs.realpath(destination),
    fingerprint: sourceLoaded.fingerprint, copied: true };
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  const queue = [{ absolute: root, relative: "." }];
  let entries = 0;
  while (queue.length) {
    const item = queue.shift();
    const stat = await fs.lstat(item.absolute);
    if (stat.isSymbolicLink()) throw new Error(`Archived theme contains a symbolic link: ${item.relative}`);
    entries += 1;
    if (entries > 100_000) throw new Error("Archived theme contains too many files");
    if (stat.isDirectory()) {
      hash.update(`d\0${item.relative}\0`);
      const children = (await fs.readdir(item.absolute)).sort();
      for (const name of children) queue.push({
        absolute: path.join(item.absolute, name),
        relative: path.posix.join(item.relative, name),
      });
    } else if (stat.isFile()) {
      hash.update(`f\0${item.relative}\0${stat.size}\0`);
      for await (const chunk of createReadStream(item.absolute)) hash.update(chunk);
    } else {
      throw new Error(`Archived theme contains an unsupported entry: ${item.relative}`);
    }
  }
  return hash.digest("hex");
}

async function copyAndValidateArchive(source, destinationRoot) {
  const digest = await treeDigest(source);
  const destination = path.join(destinationRoot, path.basename(source));
  const existing = await fs.lstat(destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`Archived theme migration conflict at ${destination}`);
    if (await treeDigest(destination) !== digest) throw new Error(`Archived theme migration conflict at ${destination}`);
    return { source, destination: await fs.realpath(destination), digest, copied: false };
  }
  const stage = path.join(destinationRoot, `.migrate-deleted-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fs.cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    if (await treeDigest(stage) !== digest) throw new Error(`Archived theme migration validation failed for ${path.basename(source)}`);
    await fs.rename(stage, destination);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
  return { source, destination: await fs.realpath(destination), digest, copied: true };
}

export async function finalizeThemeLibraryMigration(result) {
  for (const theme of result?.themes ?? []) {
    const source = await fs.realpath(theme.source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!source) continue;
    const loaded = await loadInstalledSkin(source, CLIENT_OPTIONS);
    if (loaded.theme.id !== theme.themeId || loaded.fingerprint !== theme.fingerprint) {
      throw new Error(`Source theme changed before migration cleanup: ${theme.themeId}`);
    }
  }
  for (const archive of result?.archives ?? []) {
    const source = await fs.realpath(archive.source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!source) continue;
    if (await treeDigest(source) !== archive.digest) {
      throw new Error(`Archived theme changed before migration cleanup: ${path.basename(archive.source)}`);
    }
  }
  for (const theme of result?.themes ?? []) await fs.rm(theme.source, { recursive: true });
  for (const archive of result?.archives ?? []) await fs.rm(archive.source, { recursive: true });
  const deletedRoot = path.join(result?.sourceRoot ?? "", ".deleted");
  if (result?.sourceRoot) await fs.rmdir(deletedRoot).catch((error) => {
    if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
  });
}

export async function rollbackThemeLibraryMigration(result) {
  for (const theme of (result?.themes ?? []).filter((item) => item.copied)) {
    const destination = await fs.realpath(theme.destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!destination) continue;
    const loaded = await loadInstalledSkin(destination, CLIENT_OPTIONS);
    if (loaded.theme.id !== theme.themeId || loaded.fingerprint !== theme.fingerprint) {
      throw new Error(`Destination theme changed before migration rollback: ${theme.themeId}`);
    }
  }
  for (const archive of (result?.archives ?? []).filter((item) => item.copied)) {
    const destination = await fs.realpath(archive.destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!destination) continue;
    if (await treeDigest(destination) !== archive.digest) {
      throw new Error(`Archived theme changed before migration rollback: ${path.basename(archive.destination)}`);
    }
  }
  for (const theme of (result?.themes ?? []).filter((item) => item.copied)) {
    await fs.rm(theme.destination, { recursive: true });
  }
  for (const archive of (result?.archives ?? []).filter((item) => item.copied)) {
    await fs.rm(archive.destination, { recursive: true });
  }
}

export async function migrateThemeLibrary({ sourceRoot, destinationRoot, removeSource = true }) {
  const requestedSource = path.resolve(sourceRoot);
  const requestedDestination = path.resolve(destinationRoot);
  if (isWithin(requestedSource, requestedDestination) || isWithin(requestedDestination, requestedSource)) {
    throw new Error("Source and destination theme libraries must not contain each other");
  }
  const source = await existingDirectory(sourceRoot, "Source theme library");
  if (isWithin(source, requestedDestination) || isWithin(requestedDestination, source)) {
    throw new Error("Source and destination theme libraries must not contain each other");
  }
  const destination = await existingDirectory(destinationRoot, "Destination theme library");
  if (isWithin(source, destination) || isWithin(destination, source)) {
    throw new Error("Source and destination theme libraries must not contain each other");
  }
  await fs.access(destination, fs.constants.W_OK);
  const directories = [];
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
      directories.push(path.join(source, entry.name));
    }
  }
  const themes = [];
  const archives = [];
  try {
    for (const directory of directories.sort()) themes.push(await copyAndValidateTheme(directory, destination));
    const deletedSource = path.join(source, ".deleted");
    const deletedEntries = await fs.readdir(deletedSource, { withFileTypes: true }).catch((error) =>
      error?.code === "ENOENT" ? [] : Promise.reject(error));
    if (deletedEntries.length) {
      const deletedDestination = path.join(destination, ".deleted");
      await fs.mkdir(deletedDestination, { recursive: true, mode: 0o700 });
      for (const entry of deletedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) throw new Error(`Archived theme contains a symbolic link: ${entry.name}`);
        archives.push(await copyAndValidateArchive(path.join(deletedSource, entry.name), deletedDestination));
      }
    }
  } catch (error) {
    await rollbackThemeLibraryMigration({ themes, archives });
    throw error;
  }
  const result = { sourceRoot: source, destinationRoot: destination, themes, archives };
  if (removeSource) await finalizeThemeLibraryMigration(result);
  return result;
}

export async function chooseThemeLibraryDirectory() {
  const script = [
    "with timeout of 600 seconds",
    "tell application \"Finder\"",
    "activate",
    "set selectedFolder to choose folder with prompt \"选择 Dream Skin 主题素材库存放位置\"",
    "end tell",
    "end timeout",
    "return POSIX path of selectedFolder",
  ];
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), {
      timeout: 10 * 60_000, maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch (error) {
    if (error?.code === 1 || /User canceled/i.test(error?.stderr ?? "")) return null;
    throw error;
  }
}
