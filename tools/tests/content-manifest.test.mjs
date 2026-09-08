import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContentManifest,
  verifyContentManifest,
  writeContentManifest,
} from "../../runtime/dynamic/content-manifest.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-content-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "media"));
  await fs.writeFile(path.join(root, "theme.json"), "{\"schemaVersion\":2}\n");
  await fs.writeFile(path.join(root, "media", "visual.mp4"), "video-bytes\n");
  return root;
}

test("builds a stable sorted content identity independent of caller order", async (t) => {
  const root = await fixture(t);
  const left = await buildContentManifest(root, ["theme.json", "media/visual.mp4"]);
  const right = await buildContentManifest(root, ["media/visual.mp4", "theme.json"]);

  assert.deepEqual(left, right);
  assert.match(left.versionId, /^skin_[0-9a-f]{64}$/);
  assert.deepEqual(left.files.map((entry) => entry.path), ["media/visual.mp4", "theme.json"]);
  assert.ok(left.files.every((entry) => Number.isSafeInteger(entry.bytes) && /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert.deepEqual(await verifyContentManifest(root, left), left);
});

test("verification rejects drift, extra identities, unsafe paths, and non-regular files", async (t) => {
  const root = await fixture(t);
  const manifest = await buildContentManifest(root, ["theme.json", "media/visual.mp4"]);
  await fs.appendFile(path.join(root, "media", "visual.mp4"), "changed");
  await assert.rejects(() => verifyContentManifest(root, manifest), /identity|hash|size/i);

  await assert.rejects(() => buildContentManifest(root, ["theme.json", "../escape"]), /canonical|path/i);
  await assert.rejects(() => buildContentManifest(root, ["theme.json", "Theme.json", "theme.json"]), /collision|duplicate/i);
  await fs.symlink(path.join(root, "theme.json"), path.join(root, "linked.json"));
  await assert.rejects(() => buildContentManifest(root, ["linked.json"]), /symbolic|regular/i);
});

test("rejects final file links even when the platform does not enforce O_NOFOLLOW", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.symlink(path.join(outside, "theme.json"), path.join(root, "linked.json"), "file");
  const open = fs.open.bind(fs);
  // Windows does not expose O_NOFOLLOW. Exercise its semantics with real files
  // on every host instead of letting the POSIX flag hide missing validation.
  t.mock.method(fs, "open", (file, flags, ...args) =>
    open(file, typeof flags === "number" ? flags & ~(fsConstants.O_NOFOLLOW ?? 0) : flags, ...args));
  await assert.rejects(() => buildContentManifest(root, ["linked.json"]), /symbolic|regular|escape/i);
});

test("rejects linked parent directories pointing inside or outside the content root", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const directoryLink = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(root, "media"), path.join(root, "inside"), directoryLink);
  await fs.symlink(path.join(outside, "media"), path.join(root, "outside"), directoryLink);
  for (const relativePath of ["inside/visual.mp4", "outside/visual.mp4"]) {
    await assert.rejects(() => buildContentManifest(root, [relativePath]), /symbolic|regular|escape/i);
  }
});

test("canonicalizes aliases above the requested root without allowing a linked root itself", async (t) => {
  const parent = await fixture(t);
  const root = path.join(parent, "media");
  const aliasParent = await fixture(t);
  const alias = path.join(aliasParent, "temp-alias");
  await fs.symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
  const manifest = await buildContentManifest(root, ["visual.mp4"]);
  // This is the same shape as macOS /tmp/theme -> /private/tmp/theme.
  assert.deepEqual(await buildContentManifest(path.join(alias, "media"), ["visual.mp4"]), manifest);
  await assert.rejects(() => buildContentManifest(alias, ["theme.json"]), /root|symbolic|regular/i);
});

test("rejects a parent directory swapped to an escaping link immediately before file open", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const media = path.join(root, "media");
  const original = path.join(root, "original-media");
  const open = fs.open.bind(fs);
  let swapped = false;
  t.mock.method(fs, "open", async (...args) => {
    if (!swapped) {
      swapped = true;
      await fs.rename(media, original);
      await fs.symlink(path.join(outside, "media"), media, process.platform === "win32" ? "junction" : "dir");
    }
    return open(...args);
  });
  await assert.rejects(() => buildContentManifest(root, ["media/visual.mp4"]), /symbolic|changed|escape/i);
});

test("rejects regular-file replacement between path inspection and handle open", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "theme.json");
  const open = fs.open.bind(fs);
  let replaced = false;
  t.mock.method(fs, "open", async (...args) => {
    if (!replaced) {
      replaced = true;
      await fs.rename(file, path.join(root, "original.json"));
      await fs.writeFile(file, "untrusted replacement\n");
    }
    return open(...args);
  });
  await assert.rejects(() => buildContentManifest(root, ["theme.json"]), /changed|identity/i);
});

test("rejects a parent replaced after reading even when the original file handle stays stable", async (t) => {
  const root = await fixture(t);
  const media = path.join(root, "media");
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const readFile = handle.readFile.bind(handle);
    handle.readFile = async (...readArgs) => {
      const bytes = await readFile(...readArgs);
      await fs.rename(media, path.join(root, "original-media"));
      await fs.mkdir(media);
      await fs.writeFile(path.join(media, "visual.mp4"), "replacement after read\n");
      return bytes;
    };
    return handle;
  });
  await assert.rejects(() => buildContentManifest(root, ["media/visual.mp4"]), /changed|identity/i);
});

test("writes the manifest once and detects immutable collisions", async (t) => {
  const root = await fixture(t);
  const manifest = await buildContentManifest(root, ["theme.json", "media/visual.mp4"]);
  const destination = path.join(root, "content-manifest.json");

  assert.equal(await writeContentManifest(destination, manifest), true);
  assert.equal(await writeContentManifest(destination, manifest), false);
  await fs.writeFile(destination, "{}\n");
  await assert.rejects(() => writeContentManifest(destination, manifest), /collision|different/i);
});
