import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { canonicalAssetPath } from "./theme-contract.mjs";

const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_NAME = "content-manifest.json";

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} has invalid fields`);
  }
}

async function canonicalRoot(root) {
  const requested = path.resolve(root);
  const stat = await fs.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Content root must be a regular directory");
  return fs.realpath(requested);
}

function orderedPaths(expectedPaths) {
  if (expectedPaths == null || typeof expectedPaths[Symbol.iterator] !== "function") {
    fail("Expected content paths must be iterable");
  }
  const folded = new Map();
  const result = [];
  for (const value of expectedPaths) {
    const normalized = canonicalAssetPath(value);
    if (normalized === MANIFEST_NAME) fail("The content manifest cannot hash itself");
    const key = normalized.toLowerCase();
    if (folded.has(key)) fail(`Content path collision: ${folded.get(key)} and ${normalized}`);
    folded.set(key, normalized);
    result.push(normalized);
  }
  if (result.length < 1 || result.length > 64) fail("Content manifest must contain between 1 and 64 files");
  return result.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function hashRegularFile(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  let handle;
  try {
    handle = await fs.open(absolutePath, OPEN_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${relativePath} must not be a symbolic link`);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1) {
      fail(`${relativePath} must be a non-empty regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
      fail(`${relativePath} changed while its content identity was computed`);
    }
    return Object.freeze({
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function versionIdFor(files) {
  const aggregate = createHash("sha256");
  for (const entry of files) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(entry.bytes));
    aggregate.update(pathLength).update(pathBytes).update(size).update(Buffer.from(entry.sha256, "hex"));
  }
  return `skin_${aggregate.digest("hex")}`;
}

function validateManifestShape(manifest) {
  exactKeys(manifest, ["schemaVersion", "versionId", "files"], "Content manifest");
  if (manifest.schemaVersion !== 1 || !/^skin_[0-9a-f]{64}$/.test(manifest.versionId)
      || !Array.isArray(manifest.files)) fail("Content manifest identity is invalid");
  const paths = orderedPaths(manifest.files.map((entry) => entry?.path));
  if (paths.some((value, index) => value !== manifest.files[index]?.path)) {
    fail("Content manifest files must be sorted");
  }
  const files = manifest.files.map((entry, index) => {
    exactKeys(entry, ["path", "bytes", "sha256"], `Content manifest file ${index}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !HASH_PATTERN.test(entry.sha256)) {
      fail(`Content manifest file ${index} identity is invalid`);
    }
    return Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  });
  if (versionIdFor(files) !== manifest.versionId) fail("Content manifest aggregate identity is invalid");
  return Object.freeze({ schemaVersion: 1, versionId: manifest.versionId, files: Object.freeze(files) });
}

export async function buildContentManifest(root, expectedPaths) {
  const realRoot = await canonicalRoot(root);
  const files = [];
  for (const relativePath of orderedPaths(expectedPaths)) {
    files.push(await hashRegularFile(realRoot, relativePath));
  }
  return Object.freeze({
    schemaVersion: 1,
    versionId: versionIdFor(files),
    files: Object.freeze(files),
  });
}

export async function verifyContentManifest(root, manifest) {
  const expected = validateManifestShape(manifest);
  const actual = await buildContentManifest(root, expected.files.map((entry) => entry.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Content manifest file identity does not match");
  return actual;
}

export async function writeContentManifest(destination, manifest) {
  const validated = validateManifestShape(manifest);
  const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
  try {
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await fs.readFile(destination);
    if (!existing.equals(bytes)) fail("Immutable content manifest collision: destination contains different bytes");
    return false;
  }
}
