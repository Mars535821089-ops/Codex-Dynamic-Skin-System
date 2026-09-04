import fs from "node:fs/promises";
import path from "node:path";

import { readRawDimensions } from "../image-metadata.mjs";

const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_BOXES = 4096;
const MAX_ISO_TIMING_ENTRIES = 4096;
const ROLE_FAMILIES = Object.freeze({
  image: ["image"], poster: ["image"], video: ["video"],
  ambient: ["audio"], "ui-sound": ["audio"],
});
const EXTENSIONS = Object.freeze({
  png: [".png", ".apng"], jpeg: [".jpg", ".jpeg"], webp: [".webp"], gif: [".gif"],
  mp4: [".mp4"], webm: [".webm"], wav: [".wav"], mp3: [".mp3"], m4a: [".m4a"],
});

export class MediaValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

function fail(code, message) { throw new MediaValidationError(code, message); }
function ascii(bytes, offset, length) { return bytes.subarray(offset, offset + length).toString("latin1"); }
function u16be(bytes, offset) { return bytes.readUInt16BE(offset); }
function u16le(bytes, offset) { return bytes.readUInt16LE(offset); }
function u32be(bytes, offset) { return bytes.readUInt32BE(offset); }
function u32le(bytes, offset) { return bytes.readUInt32LE(offset); }

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ bytes[offset]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function assertIsoTimingTableBounds(entries, tableBytes) {
  if (!Number.isInteger(entries) || entries < 0 || !Number.isInteger(tableBytes) || tableBytes < 0) {
    fail("MEDIA_SIGNATURE", "invalid timing table bounds");
  }
  if (entries > MAX_ISO_TIMING_ENTRIES) fail("MEDIA_LIMIT", "too many timing entries");
  if (entries * 8 > tableBytes) fail("MEDIA_SIGNATURE", "truncated timing table");
  return entries;
}

async function readBounded(filePath) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_FILE_BYTES) {
    fail("MEDIA_LIMIT", `media must be a regular file between 1 and ${MAX_FILE_BYTES} bytes`);
  }
  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) fail("MEDIA_CHANGED", "media changed while opening");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || bytes.length !== opened.size) fail("MEDIA_CHANGED", "media changed while reading");
    return bytes;
  } finally { await handle.close(); }
}

function detectedContainer(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ["image", "png", "image/png"];
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) return ["image", "jpeg", "image/jpeg"];
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return ["image", "webp", "image/webp"];
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return ["image", "gif", "image/gif"];
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    const isM4a = brand === "M4A " || bytes.subarray(8, Math.min(bytes.length, 64)).includes(Buffer.from("M4A "));
    return [isM4a ? "audio" : "video", isM4a ? "m4a" : "mp4", isM4a ? "audio/mp4" : "video/mp4"];
  }
  if (bytes.length >= 16 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    && bytes.subarray(0, Math.min(bytes.length, 256)).includes(Buffer.from("webm"))) return ["video", "webm", "video/webm"];
  if (bytes.length >= 44 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return ["audio", "wav", "audio/wav"];
  if (bytes.length >= 4 && (ascii(bytes, 0, 3) === "ID3" || mp3Header(bytes, 0))) return ["audio", "mp3", "audio/mpeg"];
  fail("MEDIA_SIGNATURE", "media signature is unsupported or truncated");
}

function validateExtension(filePath, container) {
  const extension = path.extname(filePath).toLowerCase();
  if (!EXTENSIONS[container]?.includes(extension)) {
    fail("MEDIA_EXTENSION", `extension ${extension || "<none>"} does not match ${container}`);
  }
}

export async function sniffMediaFile(filePath) {
  const bytes = await readBounded(filePath);
  const [family, container, mime] = detectedContainer(bytes);
  validateExtension(filePath, container);
  return Object.freeze({ family, container, mime, sizeBytes: bytes.length });
}

function parseImage(bytes, container) {
  if (container === "png") {
    let offset = 8; let chunks = 0; let sawIhdr = false; let imageBytes = 0; let sawIend = false;
    while (offset < bytes.length && chunks++ < 4096) {
      if (offset + 12 > bytes.length) fail("MEDIA_SIGNATURE", "PNG chunk table is truncated");
      const size = u32be(bytes, offset); const type = ascii(bytes, offset + 4, 4);
      if (size > bytes.length - offset - 12) fail("MEDIA_SIGNATURE", "PNG chunk length is invalid");
      const chunkEnd = offset + 12 + size;
      if (u32be(bytes, offset + 8 + size) !== crc32(bytes, offset + 4, offset + 8 + size)) {
        fail("MEDIA_SIGNATURE", `PNG ${type} checksum is invalid`);
      }
      if (!sawIhdr) {
        if (type !== "IHDR" || size !== 13) fail("MEDIA_SIGNATURE", "PNG must begin with one IHDR chunk");
        sawIhdr = true;
      } else if (type === "IHDR") fail("MEDIA_SIGNATURE", "PNG contains duplicate IHDR metadata");
      if (type === "IDAT") imageBytes += size;
      offset += 12 + size;
      if (type === "IEND") { sawIend = size === 0; break; }
    }
    if (!sawIhdr || !imageBytes || !sawIend || offset !== bytes.length) {
      fail("MEDIA_SIGNATURE", "PNG requires image data and must end at its IEND chunk");
    }
  } else if (container === "jpeg") {
    if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      fail("MEDIA_SIGNATURE", "JPEG must end at its EOI marker");
    }
    let offset = 2; let scans = 0; let scanBytes = 0; let sawEoi = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) fail("MEDIA_SIGNATURE", "JPEG marker table is invalid");
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) fail("MEDIA_SIGNATURE", "JPEG marker is truncated");
      const marker = bytes[offset];
      const markerStart = offset - 1;
      offset += 1;
      if (marker === 0xd9) { sawEoi = offset === bytes.length; break; }
      if (marker === 0xd8 || marker === 0x00) fail("MEDIA_SIGNATURE", "JPEG marker sequence is invalid");
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) fail("MEDIA_SIGNATURE", "JPEG segment length is truncated");
      const size = u16be(bytes, offset);
      if (size < 2 || size > bytes.length - offset) fail("MEDIA_SIGNATURE", "JPEG segment length is invalid");
      offset += size;
      if (marker !== 0xda) continue;
      scans += 1;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { scanBytes += 1; offset += 1; continue; }
        let next = offset + 1;
        while (next < bytes.length && bytes[next] === 0xff) next += 1;
        if (next >= bytes.length) fail("MEDIA_SIGNATURE", "JPEG scan is truncated");
        if (bytes[next] === 0x00) { scanBytes += 1; offset = next + 1; continue; }
        if (bytes[next] >= 0xd0 && bytes[next] <= 0xd7) { offset = next + 1; continue; }
        offset = next - 1;
        break;
      }
      if (offset === markerStart) fail("MEDIA_SIGNATURE", "JPEG scan did not advance");
    }
    if (!scans || !scanBytes || !sawEoi) fail("MEDIA_SIGNATURE", "JPEG requires scan data before its EOI marker");
  } else if (container === "gif") {
    const packed = bytes[10];
    let offset = 13 + (packed & 0x80 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0);
    let images = 0;
    const skipSubBlocks = () => {
      let payloadBytes = 0;
      while (offset < bytes.length) {
        const size = bytes[offset]; offset += 1;
        if (!size) return payloadBytes;
        if (size > bytes.length - offset) fail("MEDIA_SIGNATURE", "GIF data sub-block is truncated");
        payloadBytes += size; offset += size;
      }
      fail("MEDIA_SIGNATURE", "GIF data sub-block terminator is missing");
    };
    while (offset < bytes.length) {
      const introducer = bytes[offset];
      if (introducer === 0x3b) {
        if (offset + 1 !== bytes.length || !images) fail("MEDIA_SIGNATURE", "GIF trailer or image payload is invalid");
        offset += 1;
        break;
      }
      if (introducer === 0x21) {
        if (offset + 2 > bytes.length) fail("MEDIA_SIGNATURE", "GIF extension is truncated");
        offset += 2;
        skipSubBlocks();
        continue;
      }
      if (introducer !== 0x2c || offset + 10 > bytes.length) fail("MEDIA_SIGNATURE", "GIF block table is invalid");
      const imagePacked = bytes[offset + 9];
      offset += 10;
      if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
      if (offset >= bytes.length) fail("MEDIA_SIGNATURE", "GIF image table is truncated");
      const minimumCodeSize = bytes[offset]; offset += 1;
      if (minimumCodeSize < 2 || minimumCodeSize > 8 || !skipSubBlocks()) {
        fail("MEDIA_SIGNATURE", "GIF image payload is invalid");
      }
      images += 1;
    }
    if (offset !== bytes.length || !images) fail("MEDIA_SIGNATURE", "GIF must contain an image and end at its trailer");
  } else if (container === "webp") {
    if (u32le(bytes, 4) + 8 !== bytes.length) fail("MEDIA_SIGNATURE", "WebP RIFF length is invalid");
  }
  if (container === "gif") {
    const width = u16le(bytes, 6); const height = u16le(bytes, 8);
    if (!width || !height) fail("MEDIA_SIGNATURE", "GIF dimensions are invalid");
    return { width, height };
  }
  const extension = container === "jpeg" ? ".jpg" : `.${container}`;
  const dimensions = readRawDimensions(bytes, extension);
  if (!dimensions) fail("MEDIA_SIGNATURE", `${container} structure or dimensions are invalid`);
  return dimensions;
}

function parseBoxes(bytes, start = 0, end = bytes.length, depth = 0, counter = { value: 0 }) {
  if (depth > 12) fail("MEDIA_SIGNATURE", "ISO box nesting is excessive");
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8 || ++counter.value > MAX_BOXES) fail("MEDIA_SIGNATURE", "ISO box table is invalid");
    let size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (end - offset < 16) fail("MEDIA_SIGNATURE", "truncated extended ISO box");
      const big = bytes.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("MEDIA_LIMIT", "ISO box length is excessive");
      size = Number(big); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || size > end - offset) fail("MEDIA_SIGNATURE", `invalid ${type} box length`);
    const box = { type, start: offset, data: offset + header, end: offset + size, children: [] };
    const childTypes = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
    if (childTypes.has(type)) box.children = parseBoxes(bytes, box.data, box.end, depth + 1, counter);
    if (type === "stsd") {
      if (box.data + 8 > box.end) fail("MEDIA_SIGNATURE", "truncated stsd box");
      let entry = box.data + 8;
      const count = u32be(bytes, box.data + 4);
      if (count > 64) fail("MEDIA_LIMIT", "too many sample descriptions");
      for (let index = 0; index < count; index += 1) {
        if (entry + 8 > box.end) fail("MEDIA_SIGNATURE", "truncated sample description");
        const entrySize = u32be(bytes, entry);
        if (entrySize < 8 || entrySize > box.end - entry) fail("MEDIA_SIGNATURE", "invalid sample description length");
        box.children.push({ type: ascii(bytes, entry + 4, 4), start: entry, data: entry + 8, end: entry + entrySize, children: [] });
        entry += entrySize;
      }
    }
    boxes.push(box); offset += size;
  }
  return boxes;
}

function child(box, type) { return box?.children.find((entry) => entry.type === type); }
function descendants(boxes, type, found = []) {
  for (const box of boxes) { if (box.type === type) found.push(box); descendants(box.children, type, found); }
  return found;
}

function fixedDuration(bytes, box) {
  const version = bytes[box.data];
  const timescaleOffset = box.data + (version === 1 ? 20 : 12);
  const durationOffset = box.data + (version === 1 ? 24 : 16);
  if (durationOffset + (version === 1 ? 8 : 4) > box.end) fail("MEDIA_SIGNATURE", `truncated ${box.type}`);
  const timescale = u32be(bytes, timescaleOffset);
  let duration;
  if (version === 1) {
    const rawDuration = bytes.readBigUInt64BE(durationOffset);
    if (rawDuration > BigInt(Number.MAX_SAFE_INTEGER)) fail("MEDIA_LIMIT", `${box.type} duration is excessive`);
    duration = Number(rawDuration);
  } else duration = u32be(bytes, durationOffset);
  return { timescale, duration };
}

function parseIsoMedia(bytes, container) {
  const boxes = parseBoxes(bytes);
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  const mediaData = boxes.filter((box) => box.type === "mdat")
    .reduce((total, box) => total + box.end - box.data, 0);
  if (!ftyp || !moov || !mediaData) fail("MEDIA_SIGNATURE", "ISO media requires ftyp, moov, and media payload boxes");
  const mvhd = child(moov, "mvhd");
  if (!mvhd) fail("MEDIA_SIGNATURE", "ISO media is missing movie metadata");
  const movieTime = fixedDuration(bytes, mvhd);
  const durationSeconds = movieTime.timescale ? movieTime.duration / movieTime.timescale : 0;
  let video = null; let audio = null;
  for (const trak of moov.children.filter((box) => box.type === "trak")) {
    const mdia = child(trak, "mdia"); const hdlr = child(mdia, "hdlr");
    if (!mdia || !hdlr || hdlr.data + 12 > hdlr.end) continue;
    const handler = ascii(bytes, hdlr.data + 8, 4);
    const stbl = child(child(mdia, "minf"), "stbl"); const stsd = child(stbl, "stsd");
    const sample = stsd?.children[0];
    if (handler === "vide" && sample) {
      if (!["avc1", "avc3"].includes(sample.type)) fail("MEDIA_CODEC", `unsupported MP4 video codec ${sample.type}`);
      if (sample.start + 36 > sample.end) fail("MEDIA_SIGNATURE", "truncated video sample entry");
      const mdhd = child(mdia, "mdhd"); const stts = child(stbl, "stts");
      let fps = 0;
      if (mdhd && stts && stts.data + 16 <= stts.end) {
        const mediaTime = fixedDuration(bytes, mdhd);
        const entries = u32be(bytes, stts.data + 4);
        assertIsoTimingTableBounds(entries, stts.end - (stts.data + 8));
        let count = 0; let ticks = 0; let at = stts.data + 8;
        for (let index = 0; index < entries; index += 1, at += 8) {
          if (at + 8 > stts.end) fail("MEDIA_SIGNATURE", "truncated timing table");
          const samples = u32be(bytes, at); const delta = u32be(bytes, at + 4);
          count += samples; ticks += samples * delta;
          if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ticks)) fail("MEDIA_LIMIT", "timing table is excessive");
        }
        if (ticks) fps = count * mediaTime.timescale / ticks;
      }
      video = { codec: "h264", width: u16be(bytes, sample.start + 32), height: u16be(bytes, sample.start + 34), fps };
    } else if (handler === "soun" && sample) {
      if (sample.type !== "mp4a") fail("MEDIA_CODEC", `unsupported MP4 audio codec ${sample.type}`);
      if (sample.start + 36 > sample.end) fail("MEDIA_SIGNATURE", "truncated audio sample entry");
      audio = { codec: "aac", channels: u16be(bytes, sample.start + 24), sampleRate: u32be(bytes, sample.start + 32) >>> 16 };
    }
  }
  if (container === "mp4" && !video) fail("MEDIA_CODEC", "MP4 requires H.264 video");
  if (container === "m4a" && !audio) fail("MEDIA_CODEC", "M4A requires AAC audio");
  return { durationSeconds, ...(video ?? {}), ...(container === "m4a" ? audio : audio ? {
    hasAudio: true, audioCodec: audio.codec, audioChannels: audio.channels,
    audioSampleRate: audio.sampleRate,
  } : { hasAudio: false }) };
}

function readEbmlVint(bytes, offset, keepMarker, maxWidth) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]; let width = 1; let mask = 0x80;
  while (width <= maxWidth && !(first & mask)) { width += 1; mask >>= 1; }
  if (width > maxWidth || offset + width > bytes.length) return null;
  let value = BigInt(keepMarker ? first : first & (mask - 1));
  for (let index = 1; index < width; index += 1) value = value * 256n + BigInt(bytes[offset + index]);
  const unknown = !keepMarker && value === (1n << BigInt(7 * width)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) fail("MEDIA_LIMIT", "EBML element length is excessive");
  return { width, value: Number(value), unknown };
}

const EBML_MASTERS = new Set([
  0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0xae, 0xe0, 0xa0,
]);

function parseEbmlElements(bytes, start = 0, end = bytes.length, depth = 0, counter = { value: 0 }) {
  if (depth > 8) fail("MEDIA_SIGNATURE", "EBML nesting is excessive");
  const elements = []; let offset = start;
  while (offset < end) {
    if (++counter.value > MAX_BOXES) fail("MEDIA_LIMIT", "too many EBML elements");
    const id = readEbmlVint(bytes, offset, true, 4);
    if (!id) fail("MEDIA_SIGNATURE", "invalid EBML element ID");
    const size = readEbmlVint(bytes, offset + id.width, false, 8);
    if (!size) fail("MEDIA_SIGNATURE", "invalid EBML element length");
    const data = offset + id.width + size.width;
    const elementEnd = size.unknown ? end : data + size.value;
    if (elementEnd < data || elementEnd > end) fail("MEDIA_SIGNATURE", "EBML element exceeds its parent");
    const element = { id: id.value, data, end: elementEnd, children: [] };
    if (EBML_MASTERS.has(element.id)) {
      element.children = parseEbmlElements(bytes, data, elementEnd, depth + 1, counter);
    }
    elements.push(element);
    if (size.unknown && elementEnd !== end) fail("MEDIA_SIGNATURE", "unknown EBML length must consume its parent");
    offset = elementEnd;
  }
  return elements;
}

function ebmlChild(element, id) { return element?.children.find((entry) => entry.id === id); }

function ebmlDescendants(elements, id, found = []) {
  for (const element of elements) {
    if (element.id === id) found.push(element);
    ebmlDescendants(element.children, id, found);
  }
  return found;
}

function readEbmlUnsigned(bytes, element) {
  if (!element || element.end <= element.data || element.end - element.data > 8) return null;
  let value = 0;
  for (let i = element.data; i < element.end; i += 1) value = value * 256 + bytes[i];
  return value;
}

function readEbmlFloat(bytes, element) {
  const size = element ? element.end - element.data : 0;
  if (![4, 8].includes(size)) return null;
  return size === 4 ? bytes.readFloatBE(element.data) : bytes.readDoubleBE(element.data);
}

function parseWebm(bytes) {
  const roots = parseEbmlElements(bytes);
  const header = roots.find((entry) => entry.id === 0x1a45dfa3);
  const segment = roots.find((entry) => entry.id === 0x18538067);
  const info = ebmlChild(segment, 0x1549a966); const tracks = ebmlChild(segment, 0x1654ae6b);
  if (!header || !segment || !info || !tracks) fail("MEDIA_SIGNATURE", "WebM structure is incomplete");
  const clusters = segment.children.filter((entry) => entry.id === 0x1f43b675);
  const blocks = [
    ...ebmlDescendants(clusters, 0xa3),
    ...ebmlDescendants(clusters, 0xa1),
  ];
  if (!blocks.some((block) => block.end - block.data >= 5)) {
    fail("MEDIA_SIGNATURE", "WebM requires a Cluster with encoded block payload");
  }
  const videoTrack = tracks.children.filter((entry) => entry.id === 0xae).find((track) => {
    const type = readEbmlUnsigned(bytes, ebmlChild(track, 0x83));
    const codec = ebmlChild(track, 0x86);
    return type === 1 && codec && ascii(bytes, codec.data, codec.end - codec.data) === "V_VP9";
  });
  if (!videoTrack) fail("MEDIA_CODEC", "WebM requires VP9 video");
  const video = ebmlChild(videoTrack, 0xe0);
  const width = readEbmlUnsigned(bytes, ebmlChild(video, 0xb0));
  const height = readEbmlUnsigned(bytes, ebmlChild(video, 0xba));
  const defaultDuration = readEbmlUnsigned(bytes, ebmlChild(videoTrack, 0x23e383));
  const timecodeScale = readEbmlUnsigned(bytes, ebmlChild(info, 0x2ad7b1)) ?? 1_000_000;
  const duration = readEbmlFloat(bytes, ebmlChild(info, 0x4489));
  if (!width || !height || !defaultDuration || !duration) fail("MEDIA_SIGNATURE", "WebM video metadata is incomplete");
  return { codec: "vp9", width, height, fps: 1e9 / defaultDuration,
    durationSeconds: duration * timecodeScale / 1e9 };
}

function parseWav(bytes) {
  let offset = 12; let format = null; let dataBytes = 0;
  for (let count = 0; offset + 8 <= bytes.length && count < 128; count += 1) {
    const type = ascii(bytes, offset, 4); const size = u32le(bytes, offset + 4); const data = offset + 8;
    if (size > bytes.length - data) fail("MEDIA_SIGNATURE", "WAV chunk length is invalid");
    if (type === "fmt ") {
      if (size < 16) fail("MEDIA_SIGNATURE", "WAV fmt chunk is truncated");
      format = { code: u16le(bytes, data), channels: u16le(bytes, data + 2), sampleRate: u32le(bytes, data + 4), byteRate: u32le(bytes, data + 8) };
    } else if (type === "data") dataBytes += size;
    offset = data + size + (size % 2);
  }
  if (!format || format.code !== 1 || !dataBytes || !format.byteRate) fail("MEDIA_CODEC", "WAV requires bounded PCM audio");
  return { codec: "pcm", channels: format.channels, sampleRate: format.sampleRate, durationSeconds: dataBytes / format.byteRate };
}

function mp3Header(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[offset + 1] >> 3) & 3; const layerBits = (bytes[offset + 1] >> 1) & 3;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 15; const rateIndex = (bytes[offset + 2] >> 2) & 3;
  if (versionBits === 1 || layerBits !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) return null;
  const rates = versionBits === 3 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const table = versionBits === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = table[bitrateIndex] * 1000; const sampleRate = rates[rateIndex];
  const padding = (bytes[offset + 2] >> 1) & 1; const frameLength = Math.floor((versionBits === 3 ? 144 : 72) * bitrate / sampleRate) + padding;
  return { bitrate, sampleRate, frameLength, channels: ((bytes[offset + 3] >> 6) & 3) === 3 ? 1 : 2 };
}

function parseMp3(bytes) {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10 || [bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => value & 0x80)) fail("MEDIA_SIGNATURE", "invalid ID3 length");
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  while (offset + 4 <= bytes.length && !mp3Header(bytes, offset)) offset += 1;
  const first = mp3Header(bytes, offset);
  if (!first) fail("MEDIA_SIGNATURE", "MP3 frame header is missing");
  const secondOffset = offset + first.frameLength;
  if (secondOffset > bytes.length) fail("MEDIA_SIGNATURE", "MP3 first frame is truncated");
  const second = mp3Header(bytes, secondOffset);
  if (!second || second.sampleRate !== first.sampleRate || secondOffset + second.frameLength > bytes.length) {
    fail("MEDIA_SIGNATURE", "MP3 frame sequence is incomplete or inconsistent");
  }
  return { codec: "mp3", channels: first.channels, sampleRate: first.sampleRate, durationSeconds: (bytes.length - offset) * 8 / first.bitrate };
}

export function assertMediaWithinLimits(info, role) {
  const allowed = ROLE_FAMILIES[role];
  if (!allowed) fail("MEDIA_ROLE", `unsupported media role ${String(role)}`);
  if (!allowed.includes(info.family)) fail("MEDIA_ROLE", `${role} does not accept ${info.family}`);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  if (info.sizeBytes < 1 || info.sizeBytes > MAX_FILE_BYTES) fail("MEDIA_LIMIT", "media file size exceeds its limit");
  if (info.family === "image" && (info.sizeBytes > 16 * 1024 * 1024 || !finite(info.width) || !finite(info.height)
    || info.width > 8192 || info.height > 8192 || info.width * info.height > 40_000_000)) fail("MEDIA_LIMIT", "image dimensions or size exceed limits");
  if (info.family === "video" && (!finite(info.width) || !finite(info.height) || !finite(info.fps)
    || !finite(info.durationSeconds) || info.width < 1 || info.height < 1 || info.width > 3840
    || info.height > 2160 || info.fps <= 0 || info.fps > 60 || info.durationSeconds <= 0
    || info.durationSeconds > 60)) fail("MEDIA_LIMIT", "video metadata exceeds limits");
  const audioSizeLimit = role === "ui-sound" ? 2 * 1024 * 1024 : 32 * 1024 * 1024;
  if (info.family === "audio" && (info.sizeBytes > audioSizeLimit || !finite(info.channels) || !finite(info.sampleRate)
    || !finite(info.durationSeconds) || info.channels < 1 || info.channels > 2 || info.sampleRate < 8000
    || info.sampleRate > 96000 || info.durationSeconds <= 0
    || info.durationSeconds > (role === "ui-sound" ? 10 : 600))) fail("MEDIA_LIMIT", "audio metadata exceeds limits");
  return info;
}

export async function inspectMediaFile(filePath, { role } = {}) {
  const bytes = await readBounded(filePath);
  const [family, container, mime] = detectedContainer(bytes);
  validateExtension(filePath, container);
  const metadata = family === "image" ? parseImage(bytes, container)
    : container === "mp4" || container === "m4a" ? parseIsoMedia(bytes, container)
      : container === "webm" ? parseWebm(bytes)
        : container === "wav" ? parseWav(bytes) : parseMp3(bytes);
  const info = Object.freeze({ family, container, mime, sizeBytes: bytes.length, ...metadata });
  assertMediaWithinLimits(info, role);
  return info;
}
