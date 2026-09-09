import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const entryUrl = new URL("../scripts/open-dream-skin-macos.sh", import.meta.url);
const commonBoundary = '. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"';
const startBoundary = '/bin/bash "$SCRIPT_DIR/start-dream-skin-macos.sh"';

async function isolatedEntrySource() {
  const source = await fs.readFile(entryUrl, "utf8").catch((error) => {
    assert.fail(`The icon entry script must exist before it can satisfy the launch contract: ${error.code}`);
  });
  assert.equal(source.split(commonBoundary).length, 2, "Exactly one common dependency must be mocked.");
  assert.equal(source.split(startBoundary).length, 2, "Exactly one start dependency must be mocked.");
  const isolated = source
    .replace(commonBoundary, "mock_common")
    .replaceAll("/usr/bin/open", "mock_open")
    .replace(startBoundary, '/bin/bash "$MOCK_START"');
  const audited = isolated
    .replace(/^\s*#.*$/gmu, "")
    .replace('exec /bin/bash "$MOCK_START"', "mock_start_boundary")
    .replaceAll("2>&1", "")
    .replaceAll(">/dev/null", "");
  assert.doesNotMatch(audited,
    /[/`]|\$\(|\b(?:eval|exec|source|command|enable|PATH|BASH_ENV|ENV)\b|^\s*\./mu,
    "A new external command boundary must be explicitly isolated before this test may execute.");
  return isolated;
}

function decodeEvents(bytes) {
  if (bytes.length === 0) return [];
  const fields = bytes.toString("utf8").split("\0");
  assert.equal(fields.pop(), "");
  const events = [];
  while (fields.length) {
    const count = Number(fields.shift());
    assert.ok(Number.isSafeInteger(count) && count > 0 && count <= fields.length);
    events.push(fields.splice(0, count));
  }
  return events;
}

async function runEntry(args, { running = false, discoveryStatus = 0, openStatus = 0, startStatus = 0 } = {}) {
  const source = await isolatedEntrySource();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-icon-open."));
  try {
    const eventsPath = path.join(root, "events");
    const startPath = path.join(root, "fake start with spaces.sh");
    await fs.writeFile(eventsPath, "");
    await fs.writeFile(startPath, `#!/bin/bash
set -euo pipefail
printf '%s\\0' "$(( $# + 1 ))" start "$@" >> "$EVENTS_PATH"
printf '%s' "$$" > "$START_PID_PATH"
exit "$START_STATUS"
`);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
set -euo pipefail
record_event() { printf '%s\\0' "$#" "$@" >> "$EVENTS_PATH"; }
mock_common() {
  SCRIPT_DIR=unused-fixture-scripts
  printf '%s' "$$" > "$ENTRY_PID_PATH"
}
fail() { printf '%s\\n' "$*" >&2; exit 1; }
discover_codex_app() {
  record_event discover
  CODEX_BUNDLE="$MOCK_BUNDLE"
  return "$DISCOVERY_STATUS"
}
codex_is_running() { record_event running-check; [ "$MOCK_RUNNING" = 1 ]; }
mock_open() { record_event open "$@"; return "$OPEN_STATUS"; }
${source}
`, "icon-open-fixture", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      // No inherited shell hooks, credentials, home, executable search path,
      // real app discovery, runtime state, CDP, launchctl, or AppleScript.
      env: {
        PATH: "",
        EVENTS_PATH: eventsPath,
        ENTRY_PID_PATH: path.join(root, "entry.pid"),
        START_PID_PATH: path.join(root, "start.pid"),
        MOCK_START: startPath,
        MOCK_BUNDLE: "/unlaunched fixture/Official <&> Codex.app",
        MOCK_RUNNING: running ? "1" : "0",
        DISCOVERY_STATUS: String(discoveryStatus),
        OPEN_STATUS: String(openStatus),
        START_STATUS: String(startStatus),
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    return {
      ...result,
      events: decodeEvents(await fs.readFile(eventsPath)),
      entryPid: await fs.readFile(path.join(root, "entry.pid"), "utf8").catch(() => null),
      startPid: await fs.readFile(path.join(root, "start.pid"), "utf8").catch(() => null),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("an already-running app is only activated once, without entering the start lifecycle", async () => {
  const result = await runEntry(["--port", "19347"], { running: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, [
    ["discover"], ["running-check"], ["open", "-a", "/unlaunched fixture/Official <&> Codex.app"],
  ]);
  assert.equal(result.startPid, null);
});

test("a closed app delegates exactly once to start with the requested port and default profile", async () => {
  const result = await runEntry(["--port", "19347"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, [["discover"], ["running-check"], ["start", "--port", "19347"]]);
  assert.equal(result.startPid, result.entryPid, "The start script must replace the wrapper process.");
});

test("the default entry delegates with the standard port and no restart or profile arguments", async () => {
  const result = await runEntry([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, [["discover"], ["running-check"], ["start", "--port", "9341"]]);
});

test("both valid port boundaries pass through unchanged", async () => {
  for (const port of ["1024", "65535"]) {
    const result = await runEntry(["--port", port]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, [["discover"], ["running-check"], ["start", "--port", port]]);
  }
});

test("invalid ports fail before app discovery or any launch action", async () => {
  for (const port of ["", "0", "1023", "65536", "-1", "+19347", "19.347", " 19347", "19347 ", "1e4", "019347", "999999999999999999999999999999999999999", "19347\n"]) {
    const result = await runEntry(["--port", port]);
    assert.notEqual(result.status, 0, `Port ${JSON.stringify(port)} must be rejected.`);
    assert.match(result.stderr, /port/i);
    assert.deepEqual(result.events, []);
  }
});

test("missing, duplicate, positional and unsupported arguments fail before discovery", async () => {
  for (const args of [
    ["--port"], ["--port", "--restart-existing"], ["--port", "19347", "--port", "19348"],
    ["19347"], ["--port=19347"], ["--restart-existing"], ["--prompt-restart"],
    ["--user-data-dir", "/unused-profile"], ["--repair-watcher-only"], ["--unknown"],
  ]) {
    const result = await runEntry(args, { running: true });
    assert.notEqual(result.status, 0, `${JSON.stringify(args)} must be rejected.`);
    assert.notEqual(result.stderr, "");
    assert.deepEqual(result.events, []);
  }
});

test("discovery failure is preserved without checking or launching an app", async () => {
  const result = await runEntry([], { discoveryStatus: 19 });
  assert.equal(result.status, 19);
  assert.deepEqual(result.events, [["discover"]]);
});

test("activation failure never falls back to start or retry", async () => {
  const result = await runEntry([], { running: true, openStatus: 23 });
  assert.equal(result.status, 23);
  assert.deepEqual(result.events, [
    ["discover"], ["running-check"], ["open", "-a", "/unlaunched fixture/Official <&> Codex.app"],
  ]);
});

test("start failure is returned without retry or activation", async () => {
  const result = await runEntry(["--port", "19347"], { startStatus: 29 });
  assert.equal(result.status, 29);
  assert.deepEqual(result.events, [["discover"], ["running-check"], ["start", "--port", "19347"]]);
  assert.equal(result.startPid, result.entryPid);
});
