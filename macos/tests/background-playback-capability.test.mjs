import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const common = path.resolve(here, "../scripts/common-macos.sh");

test("background playback capability follows the real Codex process arguments", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS process arguments are required");
  // Use bash as a stable long-lived argv carrier. Node may interpret unknown
  // Chromium switches itself and exit before ps can observe the process.
  const fixture = spawn("/bin/bash", [
    "-c", "while :; do /bin/sleep 1; done", "codex-background-fixture",
    "--disable-background-media-suspend",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ], { stdio: "ignore" });
  t.after(() => { try { fixture.kill("SIGTERM"); } catch {} });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const observed = spawnSync("/bin/ps", ["-ww", "-p", String(fixture.pid), "-o", "command="])
      .stdout?.toString() ?? "";
    if (observed.includes("--disable-renderer-backgrounding")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const supported = spawnSync("/bin/bash", ["-c", `. "$1"; codex_process_has_background_playback_flags "$2"`, "_", common, String(fixture.pid)]);
  assert.equal(supported.status, 0, supported.stderr?.toString());

  const unsupported = spawnSync("/bin/bash", ["-c", `. "$1"; codex_process_has_background_playback_flags "$2"`, "_", common, String(process.pid)]);
  assert.notEqual(unsupported.status, 0, "an ordinary process must not be advertised as background-playback capable");
});
