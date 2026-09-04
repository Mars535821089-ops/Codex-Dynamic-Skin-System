#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

const [output, scenario] = process.argv.slice(2);
if (!output || !scenario) {
  console.error("Usage: make-zip-fixture.mjs <output.zip> <scenario>");
  process.exit(2);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function entry(name, data = "x", options = {}) {
  return { name, data: Buffer.from(data), method: 0, mode: 0o100644, flags: 0x800, ...options };
}

const base = [
  entry("theme.json", '{"schemaVersion":2}\n'),
  entry("theme.css", ':root { color: white; }\n'),
];

const scenarios = {
  "valid-nested": [...base, entry("media/loop.mp4", "video"), entry("audio/complete.wav", "sound")],
  "valid-deflate": [...base, entry("media/loop.mp4", "video", { method: 8 })],
  duplicate: [...base, entry("media/a.mp4"), entry("media/a.mp4")],
  "case-collision": [...base, entry("media/Loop.mp4"), entry("media/loop.mp4")],
  "unicode-collision": [...base, entry("media/caf\u00e9.mp4"), entry("media/cafe\u0301.mp4")],
  traversal: [...base, entry("../escape.mp4")],
  absolute: [...base, entry("/tmp/escape.mp4")],
  "windows-device": [...base, entry("media/CON.mp4")],
  control: [...base, entry("media/bad\nname.mp4")],
  symlink: [...base, entry("media/link.mp4", "theme.json", { mode: 0o120777 })],
  fifo: [...base, entry("media/pipe", "", { mode: 0o010644 })],
  unsupported: [...base, entry("media/loop.mp4", "video", { method: 12 })],
  encrypted: [...base, entry("media/loop.mp4", "video", { flags: 0x801 })],
  "oversized-entry": [...base, entry("media/loop.mp4", "x", { declaredSize: 100663297 })],
  "oversized-total": [
    ...base,
    entry("media/a.mp4", "a", { declaredSize: 100663296 }),
    entry("media/b.mp4", "b", { declaredSize: 100663296 }),
    entry("media/c.mp4", "c", { declaredSize: 67108865 }),
  ],
  "nested-archive": [...base, entry("media/payload.zip")],
  "too-many": Array.from({ length: 65 }, (_, index) => entry(`media/${index}.bin`)),
};

const entries = scenarios[scenario];
if (!entries) throw new Error(`Unknown ZIP fixture scenario: ${scenario}`);

const localParts = [];
const centralParts = [];
let offset = 0;
for (const item of entries) {
  const name = Buffer.from(item.name, "utf8");
  const compressed = item.method === 8 ? deflateRawSync(item.data) : item.data;
  const size = item.declaredSize ?? item.data.length;
  const crc = crc32(item.data);
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(item.flags), u16(item.method), u16(0), u16(0),
    u32(crc), u32(compressed.length), u32(size), u16(name.length), u16(0), name, compressed,
  ]);
  localParts.push(local);
  centralParts.push(Buffer.concat([
    u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(item.flags), u16(item.method),
    u16(0), u16(0), u32(crc), u32(compressed.length), u32(size), u16(name.length),
    u16(0), u16(0), u16(0), u16(0), u32((item.mode << 16) >>> 0), u32(offset), name,
  ]));
  offset += local.length;
}

const central = Buffer.concat(centralParts);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
  u32(central.length), u32(offset), u16(0),
]);
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, Buffer.concat([...localParts, central, eocd]));
