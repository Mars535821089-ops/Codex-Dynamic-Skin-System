import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const preflight = path.join(projectRoot, "runtime", "dynamic", "zip-preflight.mjs");
const fixtureBuilder = path.join(projectRoot, "macos", "tests", "helpers", "make-zip-fixture.mjs");

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("shared ZIP preflight accepts portable nested media and rejects hostile structures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreamskin-zip-preflight-"));
  try {
    for (const scenario of ["valid-nested", "valid-deflate"]) {
      const archive = path.join(root, `${scenario}.zip`);
      assert.equal(run(fixtureBuilder, [archive, scenario]).status, 0);
      const result = run(preflight, [archive]);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.ok(summary.entries >= 3);
      assert.match(summary.archiveSha256, /^[a-f0-9]{64}$/);
      assert.equal(summary.limits.compressed, 128 * 1024 * 1024);
      assert.equal(summary.limits.expanded, 256 * 1024 * 1024);
      assert.equal(summary.limits.entries, 64);
      assert.equal(summary.limits.single, 96 * 1024 * 1024);
    }

    for (const scenario of [
      "duplicate", "case-collision", "unicode-collision", "traversal", "absolute",
      "windows-device", "control", "symlink", "fifo", "unsupported", "encrypted",
      "oversized-entry", "oversized-total", "nested-archive", "too-many",
    ]) {
      const archive = path.join(root, `${scenario}.zip`);
      assert.equal(run(fixtureBuilder, [archive, scenario]).status, 0);
      const result = run(preflight, [archive]);
      assert.notEqual(result.status, 0, `${scenario} was unexpectedly accepted`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
