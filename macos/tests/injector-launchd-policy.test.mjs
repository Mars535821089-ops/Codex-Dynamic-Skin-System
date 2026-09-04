import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const common = path.resolve(here, "../scripts/common-macos.sh");
if (process.platform !== "darwin") {
  console.log("SKIP: injector launchd policy requires macOS launchd.");
  process.exit(0);
}
const node = process.execPath;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-launchd-policy."));
const label = `com.mars.codexdreamskin.test.${process.pid}`;
const injector = path.join(root, "fake-injector.mjs");
let watcherPid = null;

try {
  await fs.writeFile(injector, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const launch = spawnSync("/bin/bash", ["-c", `
set -euo pipefail
. "$1"
STATE_ROOT="$2"
THEME_DIR="$STATE_ROOT/theme"
INJECTOR_LOG="$STATE_ROOT/injector.log"
INJECTOR_ERROR_LOG="$STATE_ROOT/injector-error.log"
OPERATION_STATE_PATH="$STATE_ROOT/operation-state.plist"
OPERATION_ACK_PATH="$STATE_ROOT/operation-control-ack.json"
INJECTOR_JOB_LABEL="$3"
NODE="$4"
INJECTOR="$5"
/bin/mkdir -p "$THEME_DIR" "$STATE_ROOT/themes"
launch_injector_daemon 19355
`, "_", common, root, label, node, injector], { encoding: "utf8", timeout: 15000 });
  assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`);
  watcherPid = Number(launch.stdout.trim());
  assert.ok(Number.isSafeInteger(watcherPid) && watcherPid > 1, "The one-shot watcher must publish its PID.");

  const printed = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.doesNotMatch(printed.stdout, /\bkeepalive\b/i,
    "A watcher crash must stop injection instead of entering a restart loop.");

  process.kill(watcherPid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(watcherPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      break;
    }
  }

  const stopped = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /\bruns = 1\b/,
    "The one-shot watcher must not be relaunched after it exits.");
  assert.doesNotMatch(stopped.stdout, /^\s*pid = \d+/m,
    "The stopped watcher must not be replaced with a new process.");
  watcherPid = null;
} finally {
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
  spawnSync("/bin/launchctl", ["remove", label], { encoding: "utf8" });
  if (Number.isSafeInteger(watcherPid) && watcherPid > 1) {
    try { process.kill(watcherPid, "SIGTERM"); } catch {}
  }
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS: injector launchd policy is one-shot without KeepAlive.");
