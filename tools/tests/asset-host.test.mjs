import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAssetHost } from "../../runtime/dynamic/asset-host.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-asset-host-"));
  await mkdir(path.join(root, "media"));
  const bytes = Buffer.from("0123456789abcdef");
  await writeFile(path.join(root, "media", "loop.mp4"), bytes);
  return {
    root,
    bytes,
    manifest: [{
      path: "media/loop.mp4",
      mediaType: "video/mp4",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  };
}

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { Origin: "app://codex", ...(options.headers ?? {}) },
  });
}

test("asset host serves only exact generation-scoped allowlisted files", async (t) => {
  const skin = await fixture();
  t.after(() => rm(skin.root, { recursive: true, force: true }));
  const host = await createAssetHost();
  t.after(() => host.close());
  assert.match(host.token, /^[a-f0-9]{64}$/);
  assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  host.bindRendererOrigin("app://codex");
  const generation = await host.stageGeneration({ root: skin.root, manifest: skin.manifest });
  const url = generation.urlFor("media/loop.mp4");
  assert.ok(url.startsWith(`${host.origin}/`));

  const full = await request(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("cache-control"), "no-store");
  assert.equal(full.headers.get("access-control-allow-origin"), "app://codex");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), skin.bytes);

  const head = await request(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(skin.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const range = await request(url, { headers: { Range: "bytes=3-7" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 3-7/${skin.bytes.length}`);
  assert.equal(await range.text(), "34567");

  for (const [label, target, options] of [
    ["wrong origin", url, { headers: { Origin: "app://other" } }],
    ["missing origin", url, { headers: { Origin: "" } }],
    ["query", `${url}?x=1`, {}],
    ["encoded traversal", url.replace("media/loop.mp4", "media/%2e%2e/theme.json"), {}],
    ["unknown file", url.replace("loop.mp4", "other.mp4"), {}],
    ["wrong token", url.replace(host.token, "0".repeat(64)), {}],
    ["multiple ranges", url, { headers: { Range: "bytes=0-1,3-4" } }],
    ["unsupported method", url, { method: "POST" }],
  ]) {
    const response = await request(target, options);
    assert.ok(response.status >= 400, `${label} was accepted`);
  }

  assert.equal(await generation.release(), true);
  assert.equal(await generation.release(), false);
  assert.equal((await request(url)).status, 404);
});

test("asset host rejects manifest drift, links, and calls after close", async (t) => {
  const skin = await fixture();
  t.after(() => rm(skin.root, { recursive: true, force: true }));
  const host = await createAssetHost();
  host.bindRendererOrigin("app://codex");
  await assert.rejects(
    host.stageGeneration({ root: skin.root, manifest: [{ ...skin.manifest[0], bytes: 999 }] }),
    /identity/i,
  );
  await assert.rejects(
    host.stageGeneration({ root: skin.root, manifest: [{ ...skin.manifest[0], path: "../escape.mp4" }] }),
    /path/i,
  );
  await host.close();
  await assert.rejects(host.stageGeneration({ root: skin.root, manifest: skin.manifest }), /closed/i);
});

test("asset host serves an allowlisted asset stored at the generation root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-asset-host-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("root-level-image");
  await writeFile(path.join(root, "poster.png"), bytes);
  const manifest = [{
    path: "poster.png",
    mediaType: "image/png",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }];
  const host = await createAssetHost();
  t.after(() => host.close());
  host.bindRendererOrigin("app://codex");
  const generation = await host.stageGeneration({ root, manifest });

  const response = await request(generation.urlFor("poster.png"));

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("staged generations are immutable after a same-inode same-size source overwrite", async (t) => {
  const skin = await fixture();
  t.after(() => rm(skin.root, { recursive: true, force: true }));
  const sourcePath = path.join(skin.root, "media", "loop.mp4");
  const before = await stat(sourcePath);
  const host = await createAssetHost();
  t.after(() => host.close());
  host.bindRendererOrigin("app://codex");
  const generation = await host.stageGeneration({ root: skin.root, manifest: skin.manifest });
  const replacement = Buffer.from("fedcba9876543210");
  assert.equal(replacement.length, skin.bytes.length);

  await writeFile(sourcePath, replacement);
  const after = await stat(sourcePath);
  assert.equal(after.ino, before.ino, "test must overwrite the existing inode");
  assert.equal(after.size, before.size, "test must preserve the source size");

  const response = await request(generation.urlFor("media/loop.mp4"));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), skin.bytes);
});
