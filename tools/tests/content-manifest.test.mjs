import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("writes the manifest once and detects immutable collisions", async (t) => {
  const root = await fixture(t);
  const manifest = await buildContentManifest(root, ["theme.json", "media/visual.mp4"]);
  const destination = path.join(root, "content-manifest.json");

  assert.equal(await writeContentManifest(destination, manifest), true);
  assert.equal(await writeContentManifest(destination, manifest), false);
  await fs.writeFile(destination, "{}\n");
  await assert.rejects(() => writeContentManifest(destination, manifest), /collision|different/i);
});
