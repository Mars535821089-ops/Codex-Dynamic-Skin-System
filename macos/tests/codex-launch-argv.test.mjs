import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const commonSource = await fs.readFile(
  new URL("../scripts/common-macos.sh", import.meta.url), "utf8",
);
const launchSource = commonSource.match(/^launch_codex_with_cdp\(\) \{\n[\s\S]*?^\}/mu)?.[0];
assert.ok(launchSource, "The production launch function must be found before testing it.");

// Execute the real argument construction and branches, never the app or launchd.
// Do not source common-macos.sh: every dependency below is a builtin-only spy.
const mockedLaunch = launchSource
  .replace(/^\s*#.*$/gmu, "")
  .replaceAll("/usr/bin/open", "mock_open")
  .replaceAll("/usr/bin/nohup", "mock_nohup");
assert.doesNotMatch(mockedLaunch, /[/`]|\$\(|\b(?:eval|exec|source|command|enable|PATH|BASH_ENV|ENV)\b|^\s*\./mu,
  "A new external command boundary needs an explicit mock before this test may run.");

function decodeEvents(bytes) {
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

async function runLaunch({ backgroundPlayback, openCreatesProcess }) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-launch-argv."));
  try {
    const eventsPath = path.join(fixtureRoot, "events");
    const executable = path.join(fixtureRoot, "Unlaunched App.app", "Contents", "MacOS", "Fake Codex");
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
set -euo pipefail
record_event() { printf '%s\\0' "$#" "$@" >> "$EVENTS_PATH"; }
dynamic_background_playback_enabled() { [ "$BACKGROUND_PLAYBACK" = 1 ]; }
release_codex_launchd_job() { record_event release-owned-job; }
codex_is_running() { [ "$MOCK_RUNNING" = 1 ]; }
mock_open() {
  record_event launch-services "$@"
  # Model a successful LaunchServices request which discards Chromium flags.
  MOCK_RUNNING="$OPEN_CREATES_PROCESS"
  return 0
}
mock_nohup() { record_event executable "$@"; }
${mockedLaunch}
launch_codex_with_cdp 19347
wait
`, "launch-argv-fixture"], {
      encoding: "utf8",
      timeout: 5_000,
      cwd: fixtureRoot,
      // No inherited shell hooks, executable search path, app, or runtime state.
      env: {
        PATH: "",
        EVENTS_PATH: eventsPath,
        CODEX_EXE: executable,
        CODEX_BUNDLE: path.join(fixtureRoot, "Unlaunched App.app"),
        APP_LOG: path.join(fixtureRoot, "app.log"),
        APP_ERROR_LOG: path.join(fixtureRoot, "app-error.log"),
        BACKGROUND_PLAYBACK: backgroundPlayback ? "1" : "0",
        OPEN_CREATES_PROCESS: openCreatesProcess ? "1" : "0",
        MOCK_RUNNING: "0",
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return { events: decodeEvents(await fs.readFile(eventsPath)), executable };
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("a successful plain LaunchServices process cannot suppress CDP argument delivery", async () => {
  const { events, executable } = await runLaunch({ backgroundPlayback: false, openCreatesProcess: true });
  assert.deepEqual(events.filter(([kind]) => kind === "executable"), [[
    "executable", executable,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=19347",
  ]]);
  assert.deepEqual(events.map(([kind]) => kind), ["release-owned-job", "executable"],
    "CDP startup must create the executable once without a LaunchServices fallback.");
});

test("background playback opt-in reaches the same direct launch with the default profile", async () => {
  const { events, executable } = await runLaunch({ backgroundPlayback: true, openCreatesProcess: false });
  assert.deepEqual(events, [
    ["release-owned-job"],
    [
      "executable", executable,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=19347",
      "--disable-background-media-suspend",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  ], "Only the opted-in flags may be added; no isolated profile or extra launch is allowed.");
});
