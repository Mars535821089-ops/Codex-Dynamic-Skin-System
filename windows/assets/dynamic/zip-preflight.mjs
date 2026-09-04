#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const archivePath = process.argv[2];
const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const ARCHIVE_SUFFIX_PATTERN = /(?:\.zip|\.dreamskin|\.7z|\.rar|\.tar|\.tar\.gz|\.tgz|\.gz|\.bz2|\.xz)$/iu;

function fail(code, message) {
  console.error(`${code}: ${message}`);
  process.exit(2);
}

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail("CONTRACT_INVALID", `${label} is missing or invalid`);
  return value;
}

let limits;
try {
  const source = JSON.parse(fs.readFileSync(path.join(moduleRoot, "theme-contract.json"), "utf8"))?.["x-limits"];
  limits = Object.freeze({
    compressed: exactPositiveInteger(source?.zipCompressedBytes, "zipCompressedBytes"),
    expanded: exactPositiveInteger(source?.zipExpandedBytes, "zipExpandedBytes"),
    entries: exactPositiveInteger(source?.zipEntries, "zipEntries"),
    single: exactPositiveInteger(source?.singleEntryBytes, "singleEntryBytes"),
  });
  if (limits.single > limits.expanded) fail("CONTRACT_INVALID", "singleEntryBytes exceeds zipExpandedBytes");
} catch {
  fail("CONTRACT_INVALID", "generated theme-contract.json could not be loaded");
}

if (!archivePath) fail("ZIP_INVALID", "archive path is required");
let bytes;
try {
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail("ZIP_INVALID", "archive must be a non-empty regular file");
  if (stat.size > limits.compressed) fail("ZIP_LIMIT", `archive exceeds ${limits.compressed} bytes`);
  bytes = fs.readFileSync(archivePath);
} catch (error) {
  if (error?.code === "ENOENT") fail("ZIP_INVALID", "archive does not exist");
  throw error;
}

function findEocd() {
  const first = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  fail("ZIP_INVALID", "end-of-central-directory record is missing or archive has trailing data");
}

function decodeName(buffer) {
  try { return decoder.decode(buffer); } catch { fail("ASSET_PATH", "entry name is not valid UTF-8"); }
}

function canonicalName(raw, directory) {
  if (!raw || raw.length > 512 || Buffer.byteLength(raw, "utf8") > 1024) fail("ASSET_PATH", "entry name is empty or too long");
  if (raw.normalize("NFC") !== raw || CONTROL_PATTERN.test(raw) || raw.startsWith("/")
      || raw.includes("\\") || raw.includes(":") || raw.includes("//")) {
    fail("ASSET_PATH", `entry path is not canonical: ${JSON.stringify(raw)}`);
  }
  const value = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = value.split("/");
  if (!value || segments.some((segment) => segment === "." || segment === ".."
      || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(segment)
      || segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_DEVICE_PATTERN.test(segment))) {
    fail("ASSET_PATH", `entry path is not portable: ${JSON.stringify(raw)}`);
  }
  if (!directory && ARCHIVE_SUFFIX_PATTERN.test(value)) fail("ZIP_NESTED", `nested archive is forbidden: ${value}`);
  return value;
}

const eocd = findEocd();
const disk = bytes.readUInt16LE(eocd + 4);
const centralDisk = bytes.readUInt16LE(eocd + 6);
const diskEntries = bytes.readUInt16LE(eocd + 8);
const totalEntries = bytes.readUInt16LE(eocd + 10);
const centralSize = bytes.readUInt32LE(eocd + 12);
const centralOffset = bytes.readUInt32LE(eocd + 16);
if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) fail("ZIP_INVALID", "multi-disk ZIP archives are forbidden");
if (totalEntries === 0 || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP_INVALID", "empty and ZIP64 archives are forbidden");
if (totalEntries > limits.entries) fail("ZIP_LIMIT", `archive exceeds ${limits.entries} entries`);
if (centralOffset + centralSize !== eocd || centralOffset >= eocd) fail("ZIP_INVALID", "central directory bounds are invalid");

let cursor = centralOffset;
let expanded = 0;
const names = new Map();
const offsets = new Set();
const ranges = [];
for (let index = 0; index < totalEntries; index += 1) {
  if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("ZIP_INVALID", "central directory entry is malformed");
  const madeBy = bytes.readUInt16LE(cursor + 4);
  const flags = bytes.readUInt16LE(cursor + 8);
  const method = bytes.readUInt16LE(cursor + 10);
  const compressedSize = bytes.readUInt32LE(cursor + 20);
  const expandedSize = bytes.readUInt32LE(cursor + 24);
  const nameLength = bytes.readUInt16LE(cursor + 28);
  const extraLength = bytes.readUInt16LE(cursor + 30);
  const commentLength = bytes.readUInt16LE(cursor + 32);
  const diskStart = bytes.readUInt16LE(cursor + 34);
  const externalAttributes = bytes.readUInt32LE(cursor + 38);
  const localOffset = bytes.readUInt32LE(cursor + 42);
  const end = cursor + 46 + nameLength + extraLength + commentLength;
  if (end > eocd || nameLength === 0) fail("ZIP_INVALID", "central directory entry exceeds archive bounds");
  if (diskStart !== 0 || compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) fail("ZIP_INVALID", "ZIP64 or multi-disk entries are forbidden");
  if ((flags & 0x2041) !== 0) fail("ZIP_ENCRYPTED", "encrypted ZIP entries are forbidden");
  if (method !== 0 && method !== 8) fail("ZIP_METHOD", `compression method ${method} is forbidden`);
  if (expandedSize > limits.single) fail("ZIP_LIMIT", `entry exceeds ${limits.single} bytes`);
  expanded += expandedSize;
  if (!Number.isSafeInteger(expanded) || expanded > limits.expanded) fail("ZIP_LIMIT", `archive exceeds ${limits.expanded} expanded bytes`);

  const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
  const rawName = decodeName(nameBytes);
  const unixMode = (madeBy >>> 8) === 3 ? externalAttributes >>> 16 : 0;
  const unixType = unixMode & 0o170000;
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  const directory = rawName.endsWith("/") || dosDirectory || unixType === 0o040000;
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) fail("ZIP_ENTRY_TYPE", `non-regular entry is forbidden: ${JSON.stringify(rawName)}`);
  if (directory !== rawName.endsWith("/") || (directory && expandedSize !== 0)) fail("ZIP_ENTRY_TYPE", `directory metadata is inconsistent: ${JSON.stringify(rawName)}`);
  const canonical = canonicalName(rawName, directory);
  const folded = canonical.toLowerCase();
  if (names.has(folded)) fail("PATH_COLLISION", `entry collides with ${names.get(folded)}: ${canonical}`);
  names.set(folded, canonical);

  if (offsets.has(localOffset) || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail("ZIP_INVALID", "local header offset is invalid or repeated");
  offsets.add(localOffset);
  const localFlags = bytes.readUInt16LE(localOffset + 6);
  const localMethod = bytes.readUInt16LE(localOffset + 8);
  const localNameLength = bytes.readUInt16LE(localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localOffset + 28);
  const localNameStart = localOffset + 30;
  const dataStart = localNameStart + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset
      || !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)) {
    fail("ZIP_INVALID", `local header disagrees with central directory: ${canonical}`);
  }
  ranges.push([localOffset, dataEnd]);
  cursor = end;
}
if (cursor !== eocd) fail("ZIP_INVALID", "central directory entry count or size is inconsistent");
ranges.sort((left, right) => left[0] - right[0]);
for (let index = 1; index < ranges.length; index += 1) {
  if (ranges[index][0] < ranges[index - 1][1]) fail("ZIP_INVALID", "local entry ranges overlap");
}

console.log(JSON.stringify({
  entries: totalEntries,
  expandedBytes: expanded,
  archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  limits,
}));
