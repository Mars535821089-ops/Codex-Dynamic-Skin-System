import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const wrapper = path.join(projectRoot, "macos/scripts/import-media-theme-macos.sh");
const fixture = path.join(projectRoot, "tools/tests/fixtures/media/tiny.gif");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-wrapper-runtime."));
const fakeNode = path.join(root, "fake-node.sh");
const marker = path.join(root, "fake-node-used");

try {
  await fs.writeFile(fakeNode, `#!/bin/bash
/usr/bin/touch "$FAKE_NODE_MARKER"
exit 91
`, { mode: 0o700 });
  const result = spawnSync("/bin/bash", [wrapper,
    "--file", fixture,
    "--name", "Signed runtime",
    "--state-root", path.join(root, "state"),
  ], {
    encoding: "utf8",
    env: { ...process.env, DREAMSKIN_NODE: fakeNode, NODE: fakeNode, FAKE_NODE_MARKER: marker },
    timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.equal(JSON.parse(result.stdout).status, "imported");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS: media import wrapper requires the signed bundled Node runtime.");
