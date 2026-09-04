import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PATH_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._/-]*$/u;
const MAX_PATH_BYTES = 1024;
const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 96 * 1024 * 1024;
const MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm",
  "audio/wav", "audio/mpeg", "audio/mp4",
  "text/css",
]);

export class AssetHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssetHostError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssetHostError(code, message);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail("MANIFEST", `${label} fields are invalid`);
  }
}

function canonicalAssetPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":")
      || value.startsWith("/") || value.includes("//") || value.normalize("NFC") !== value
      || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || !SAFE_PATH_PATTERN.test(value)) {
    fail("ASSET_PATH", "asset path is not canonical");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
      || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" "))) {
    fail("ASSET_PATH", "asset path contains an unsafe component");
  }
  return value;
}

async function snapshotHandle(handle, destination, expectedBytes, expectedSha256) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const destinationHandle = await fs.open(
    destination,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (!result.bytesWritten) fail("IDENTITY", "asset snapshot write did not advance");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== expectedBytes || hash.digest("hex") !== expectedSha256) {
      fail("IDENTITY", "asset identity does not match the manifest");
    }
    await destinationHandle.sync();
  } finally {
    await destinationHandle.close();
  }
  await fs.chmod(destination, 0o400);
  const snapshot = await fs.lstat(destination);
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.size !== expectedBytes) {
    fail("IDENTITY", "asset snapshot identity is invalid");
  }
  return snapshot;
}

async function inspectManifest(root, manifest, snapshotDirectory) {
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 64) {
    fail("MANIFEST", "asset manifest must contain between 1 and 64 entries");
  }
  const requestedRoot = path.resolve(root);
  const rootStat = await fs.lstat(requestedRoot);
  const realRoot = await fs.realpath(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("ROOT", "asset root must be a canonical regular directory");
  }
  const entries = new Map();
  const folded = new Set();
  for (let index = 0; index < manifest.length; index += 1) {
    const item = manifest[index];
    exactObject(item, ["path", "mediaType", "bytes", "sha256"], `manifest[${index}]`);
    const relativePath = canonicalAssetPath(item.path);
    const caseKey = relativePath.toLowerCase();
    if (folded.has(caseKey)) fail("MANIFEST", "asset manifest contains a path collision");
    folded.add(caseKey);
    if (!MIME_TYPES.has(item.mediaType) || !Number.isSafeInteger(item.bytes)
        || item.bytes < 1 || item.bytes > MAX_ASSET_BYTES || !SHA256_PATTERN.test(item.sha256)) {
      fail("MANIFEST", "asset manifest identity is invalid");
    }
    const absolutePath = path.resolve(realRoot, relativePath);
    if (!absolutePath.startsWith(`${realRoot}${path.sep}`)) fail("ASSET_PATH", "asset path escapes its root");
    const before = await fs.lstat(absolutePath);
    const realFile = await fs.realpath(absolutePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== item.bytes
        || realFile !== absolutePath) {
      fail("IDENTITY", "asset identity does not match the manifest");
    }
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const snapshotPath = path.join(snapshotDirectory, `${index.toString(16).padStart(2, "0")}.asset`);
    let snapshot;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.size !== item.bytes) {
        fail("IDENTITY", "asset identity does not match the manifest");
      }
      snapshot = await snapshotHandle(handle, snapshotPath, item.bytes, item.sha256);
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
          || after.size !== opened.size) fail("IDENTITY", "asset changed while staging");
    } finally {
      await handle.close();
    }
    entries.set(relativePath, Object.freeze({
      path: snapshotPath,
      mediaType: item.mediaType,
      bytes: item.bytes,
      sha256: item.sha256,
      dev: snapshot.dev,
      ino: snapshot.ino,
    }));
  }
  return entries;
}

function parseRange(value, size) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : Math.min(size - 1, start + MAX_RANGE_BYTES - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
      || start >= size || end < start || end >= size || end - start + 1 > MAX_RANGE_BYTES) return false;
  return { start, end };
}

function send(response, status, headers = {}, body = "") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export async function createAssetHost({ logger = () => {} } = {}) {
  if (typeof logger !== "function") fail("LOGGER", "logger must be a function");
  const token = randomBytes(32).toString("hex");
  if (!TOKEN_PATTERN.test(token)) fail("TOKEN", "host token generation failed");
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-assets-"));
  await fs.chmod(snapshotRoot, 0o700);
  const generations = new Map();
  let rendererOrigin = null;
  let closed = false;

  const server = http.createServer(async (request, response) => {
    try {
      const cors = rendererOrigin && request.headers.origin === rendererOrigin
        ? { "Access-Control-Allow-Origin": rendererOrigin, Vary: "Origin" }
        : null;
      if (!cors) return send(response, 403);
      if (!request.url || request.url.length > 2048 || request.url.includes("?")
          || request.url.includes("#") || /%2f|%5c|%2e/i.test(request.url)) return send(response, 400, cors);
      if (!new Set(["GET", "HEAD"]).has(request.method)) {
        return send(response, 405, { ...cors, Allow: "GET, HEAD" });
      }
      const parts = request.url.split("/");
      if (parts.length < 4 || parts[0] !== "" || parts[1] !== token) return send(response, 404, cors);
      const generation = generations.get(parts[2]);
      if (!generation) return send(response, 404, cors);
      let assetPath;
      try { assetPath = parts.slice(3).map((part) => decodeURIComponent(part)).join("/"); } catch {
        return send(response, 400, cors);
      }
      const asset = generation.entries.get(assetPath);
      if (!asset) return send(response, 404, cors);
      const range = parseRange(request.headers.range, asset.bytes);
      if (range === false) return send(response, 416, { ...cors, "Content-Range": `bytes */${asset.bytes}` });
      const start = range?.start ?? 0;
      const end = range?.end ?? asset.bytes - 1;
      const length = end - start + 1;
      const handle = await fs.open(asset.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== asset.dev || opened.ino !== asset.ino
          || opened.size !== asset.bytes) {
        await handle.close();
        return send(response, 409, cors);
      }
      response.writeHead(range ? 206 : 200, {
        ...cors,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(length),
        "Content-Type": asset.mediaType,
        "X-Content-Type-Options": "nosniff",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${asset.bytes}` } : {}),
      });
      if (request.method === "HEAD") {
        await handle.close();
        return response.end();
      }
      const stream = handle.createReadStream({ start, end, autoClose: false });
      const close = async () => { try { await handle.close(); } catch {} };
      stream.once("error", () => response.destroy());
      stream.once("close", close);
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      logger({ phase: "asset-request", category: "io", code: error?.code ?? "UNKNOWN" });
      if (!response.headersSent) send(response, 500);
      else response.destroy();
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return Object.freeze({
    origin,
    token,
    bindRendererOrigin(value) {
      if (closed) fail("CLOSED", "asset host is closed");
      if (typeof value !== "string" || value.length < 1 || value.length > 256
          || /[\u0000-\u0020\u007f]/u.test(value)) fail("ORIGIN", "renderer origin is invalid");
      if (rendererOrigin && rendererOrigin !== value) fail("ORIGIN", "renderer origin is already bound");
      rendererOrigin = value;
      return rendererOrigin;
    },
    async stageGeneration({ root, manifest } = {}) {
      if (closed) fail("CLOSED", "asset host is closed");
      if (!rendererOrigin) fail("ORIGIN", "renderer origin must be bound before staging");
      const id = randomBytes(16).toString("hex");
      const generationDirectory = path.join(snapshotRoot, id);
      await fs.mkdir(generationDirectory, { mode: 0o700 });
      let entries;
      try {
        entries = await inspectManifest(root, manifest, generationDirectory);
        if (closed) fail("CLOSED", "asset host closed while staging");
      } catch (error) {
        await fs.rm(generationDirectory, { recursive: true, force: true });
        throw error;
      }
      generations.set(id, { entries, directory: generationDirectory });
      let released = false;
      return Object.freeze({
        id,
        urlFor(relativePath) {
          const assetPath = canonicalAssetPath(relativePath);
          if (released || !entries.has(assetPath)) fail("ASSET_PATH", "asset is not in the active manifest");
          return `${origin}/${token}/${id}/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
        },
        async release() {
          if (released) return false;
          released = true;
          generations.delete(id);
          await fs.rm(generationDirectory, {
            recursive: true, force: true, maxRetries: 3, retryDelay: 25,
          });
          return true;
        },
      });
    },
    async close() {
      if (closed) return false;
      closed = true;
      generations.clear();
      try {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally {
        await fs.rm(snapshotRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      }
      return true;
    },
  });
}
