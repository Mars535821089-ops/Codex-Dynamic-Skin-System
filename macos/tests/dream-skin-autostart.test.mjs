import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  classifyCodexProcesses,
  correctionArguments,
  decidePlainLaunchCorrection,
  decideAutostartAction,
  parseAutostartArguments,
  probeSessionActivity,
  watcherStateFromStatus,
} from "../scripts/dream-skin-autostart.mjs";

const now = 10_000_000;
const cooldown = 300_000;

function snapshot(overrides = {}) {
  return {
    pids: [42],
    compliantPids: [42],
    plainPids: [],
    watcherState: "healthy",
    ...overrides,
  };
}

const execFileAsync = promisify(execFile);
const inactiveStatus = { session: "off", operation: "", injectorAlive: false, codexPid: 0 };

// Run the real monitor CLI and state I/O, replacing only its external processes.
// The preload never delegates to real ps/bash, even for an unexpected command.
async function runMonitorFixture({
  cdp = true,
  allowRestart = false,
  rounds = [{ statuses: [inactiveStatus] }],
  initialState,
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dream-skin-monitor-"));
  try {
    const startScript = path.join(root, "start.sh");
    const statusScript = path.join(root, "status.sh");
    const statePath = path.join(root, "monitor.json");
    const callsPath = path.join(root, "calls.jsonl");
    const sessionsRoot = path.join(root, "sessions");
    const preloadPath = path.join(root, "process-preload.mjs");
    await fsp.mkdir(sessionsRoot);
    await fsp.writeFile(startScript, "exit 99\n");
    await fsp.writeFile(statusScript, "exit 99\n");
    if (initialState) await fsp.writeFile(statePath, JSON.stringify(initialState));
    await fsp.writeFile(preloadPath, String.raw`
import childProcess from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
const statuses = JSON.parse(process.env.TEST_STATUSES);
const snapshots = JSON.parse(process.env.TEST_PROCESS_SNAPSHOTS || "null");
const startedTimes = JSON.parse(process.env.TEST_STARTED_TIMES || "null");
const defaultStarted = new Date(Date.now() - Number(process.env.TEST_APP_AGE_MS)).toISOString();
let statusIndex = 0;
let snapshotIndex = 0;
let startedTimeIndex = 0;
childProcess.spawn = (command, args) => {
  fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ command, args }) + "\n");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    let output = "";
    let code = 0;
    if (command === "/bin/ps" && args[0] === "-axo") {
      const snapshot = snapshots?.[Math.min(snapshotIndex++, snapshots.length - 1)]
        ?? { pid: 42, port: process.env.TEST_CDP === "1" ? 9341 : null };
      output = snapshot.pid + " /fixture/Codex.app/Contents/MacOS/Codex" +
        (snapshot.port ? " --remote-debugging-address=127.0.0.1 --remote-debugging-port=" + snapshot.port : "") + "\n";
    } else if (command === "/bin/ps" && args[0] === "-p") {
      output = (startedTimes
        ? startedTimes[Math.min(startedTimeIndex++, startedTimes.length - 1)] ?? ""
        : defaultStarted) + "\n";
    } else if (command === "/bin/bash" && args[0] === process.env.TEST_STATUS) {
      output = JSON.stringify(statuses[Math.min(statusIndex++, statuses.length - 1)]) + "\n";
    } else if (command !== "/bin/bash" || args[0] !== process.env.TEST_START) {
      code = 99;
      child.stderr.write("Unexpected external process: " + command);
    }
    child.stdout.end(output);
    child.stderr.end();
    child.emit("exit", code);
  });
  return child;
};
syncBuiltinESMExports();
`);
    const results = [];
    for (const round of rounds) {
      await fsp.writeFile(callsPath, "");
      const args = [
        "--import", preloadPath,
        fileURLToPath(new URL("../scripts/dream-skin-autostart.mjs", import.meta.url)),
        "--once", "--app-executable", "/fixture/Codex.app/Contents/MacOS/Codex",
        "--start-script", startScript, "--status-script", statusScript,
        "--state", statePath, "--sessions-root", sessionsRoot,
        "--disabled-marker", path.join(root, "native.disabled"), "--grace-ms", "100",
      ];
      if (allowRestart) args.push("--allow-codex-restart");
      await execFileAsync(process.execPath, args, {
        timeout: 10_000,
        env: {
          ...process.env,
          TEST_CALLS: callsPath, TEST_START: startScript, TEST_STATUS: statusScript,
          TEST_CDP: cdp ? "1" : "0",
          TEST_STATUSES: JSON.stringify(round.statuses),
          TEST_APP_AGE_MS: String(round.appAgeMs ?? 60_000),
          TEST_PROCESS_SNAPSHOTS: JSON.stringify(round.processSnapshots ?? null),
          TEST_STARTED_TIMES: JSON.stringify(round.startedTimes ?? null),
        },
      });
      const calls = (await fsp.readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      const state = await fsp.readFile(statePath, "utf8").then(JSON.parse, (error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      results.push({
        state,
        starts: calls.filter(({ command, args: callArgs }) => command === "/bin/bash" && callArgs[0] === startScript),
        statusProbes: calls.filter(({ command, args: callArgs }) => command === "/bin/bash" && callArgs[0] === statusScript).length,
      });
    }
    return results;
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

for (const operation of ["applying", "pausing"]) {
  test(`CLI defers ${operation} before injector state exists without declaring healthy`, async () => {
    const [result] = await runMonitorFixture({ rounds: [{ statuses: [{ ...inactiveStatus, operation }] }] });
    assert.equal(result.starts.length, 0);
    assert.equal(result.state, null);
    assert.equal(result.statusProbes, 1);
  });

  for (const cdp of [true, false]) {
    test(`CLI cancels ${cdp ? "repair" : "authorized restart"} when ${operation} begins during grace`, async () => {
      const [result] = await runMonitorFixture({
        cdp, allowRestart: !cdp,
        rounds: [{ statuses: [inactiveStatus, { ...inactiveStatus, operation }] }],
      });
      assert.equal(result.statusProbes, 2);
      assert.equal(result.starts.length, 0);
      assert.equal(result.state, null);
    });
  }
}

test("CLI does not clear a previous failure or restart latch while an operation is in progress", async () => {
  const initialState = {
    schemaVersion: 1, lastAction: "restart", lastAttemptPid: 42,
    lastAttemptAt: Date.now() - cooldown - 1000, lastResult: "failed", observedStopped: false,
  };
  const [result] = await runMonitorFixture({
    initialState,
    rounds: [{ statuses: [{ session: "active", operation: "applying", injectorAlive: true, codexPid: 42 }] }],
  });
  assert.equal(result.starts.length, 0);
  assert.deepEqual(result.state, initialState);
});

for (const expiredOperation of ["failed", ""]) {
  test(`CLI resumes repair after status expires an operation to ${expiredOperation || "empty"}`, async () => {
    const initialState = {
      schemaVersion: 1, lastAction: "repair-watcher", lastAttemptPid: 42,
      lastAttemptAt: Date.now() - cooldown - 1000, lastResult: "failed", observedStopped: false,
    };
    const results = await runMonitorFixture({
      initialState,
      rounds: [
        { statuses: [{ ...inactiveStatus, operation: "applying" }] },
        { statuses: [{ ...inactiveStatus, operation: expiredOperation }] },
      ],
    });
    assert.equal(results[0].starts.length, 0);
    assert.deepEqual(results[0].state, initialState, "busy must not renew the repair cooldown");
    assert.equal(results[1].starts.length, 1, "expiration must not leave a permanent busy latch");
    assert.deepEqual(results[1].starts[0].args.slice(1), ["--repair-watcher-only", "--port", "9341"]);
    assert.equal(results[1].state.lastResult, "ok");
  });
}

test("CLI grants a new compliant app startup grace and repairs after that grace", async () => {
  const results = await runMonitorFixture({ rounds: [
    { statuses: [inactiveStatus], appAgeMs: 0 },
    { statuses: [inactiveStatus], appAgeMs: 10_001 },
  ] });
  assert.equal(results[0].starts.length, 0);
  assert.equal(results[0].state, null);
  assert.equal(results[1].starts.length, 1);
  assert.deepEqual(results[1].starts[0].args.slice(1), ["--repair-watcher-only", "--port", "9341"]);
});

test("CLI still repairs an ordinary dead watcher and never restarts a plain app by default", async () => {
  const [broken] = await runMonitorFixture();
  assert.equal(broken.starts.length, 1);
  assert.deepEqual(broken.starts[0].args.slice(1), ["--repair-watcher-only", "--port", "9341"]);
  const [plain] = await runMonitorFixture({ cdp: false });
  assert.equal(plain.starts.length, 0);
});

test("CLI repairs on the confirmed process port instead of the persisted port", async () => {
  const startedAt = "Tue Sep  8 01:00:00 2026";
  const [result] = await runMonitorFixture({
    initialState: { schemaVersion: 1, port: 9341 },
    rounds: [{ statuses: [inactiveStatus], processSnapshots: [{ pid: 42, port: 9342 }], startedTimes: [startedAt] }],
  });
  assert.deepEqual(result.starts[0].args.slice(1), ["--repair-watcher-only", "--port", "9342"]);
  assert.equal(result.state.lastAttemptStartedAtMs, Date.parse(startedAt));
});

for (const pid of [42, 84]) {
  test(`CLI persists the new run identity for PID ${pid} and only repairs that run once during cooldown`, async () => {
    const startedAt = "Tue Sep 8 01:00:00 2026";
    const round = { statuses: [inactiveStatus], processSnapshots: [{ pid, port: 9342 }], startedTimes: [startedAt] };
    const results = await runMonitorFixture({
      rounds: [round, round],
      initialState: {
        schemaVersion: 1, lastAttemptPid: 42, lastAttemptStartedAtMs: Date.parse("Mon Sep 7 01:00:00 2026"),
        lastAttemptAt: Date.now() - 1000, lastResult: "failed", observedStopped: false,
      },
    });
    assert.deepEqual(results[0].starts.map((call) => call.args.slice(1)),
      [["--repair-watcher-only", "--port", "9342"]]);
    assert.equal(results[0].state.lastAttemptPid, pid);
    assert.equal(results[0].state.lastAttemptStartedAtMs, Date.parse(startedAt));
    assert.equal(results[1].starts.length, 0);
    assert.deepEqual(results[1].state, results[0].state);
  });
}

for (const [change, round] of Object.entries({
  port: { processSnapshots: [{ pid: 42, port: 9342 }, { pid: 42, port: 9343 }] },
  PID: { processSnapshots: [{ pid: 42, port: 9342 }, { pid: 84, port: 9342 }] },
  "start time": { startedTimes: ["Tue Sep  8 01:00:00 2026", "Tue Sep  8 02:00:00 2026"] },
  "unreadable start time": { startedTimes: [null] },
})) {
  test(`CLI cancels watcher repair when confirmation detects ${change}`, async () => {
    const [result] = await runMonitorFixture({ rounds: [{ statuses: [inactiveStatus], ...round }] });
    assert.equal(result.starts.length, 0);
    assert.notEqual(result.state?.lastResult, "ok");
  });
}

for (const [description, pid, startedAt, expected] of [
  ["a new PID", 84, now - 20_000, { action: "repair-watcher", pid: 84 }],
  ["a reused PID with a different start time", 42, now - 20_000, { action: "repair-watcher", pid: 42 }],
  ["the same confirmed run", 42, now - 60_000, { action: "wait", reason: "cooldown" }],
]) {
  test(`cooldown is bound to process identity for ${description}`, () => {
    assert.deepEqual(decideAutostartAction(snapshot({
      pids: [pid], compliantPids: [pid], watcherState: "unhealthy", appStartedAtMs: startedAt,
    }), {
      lastAction: "repair-watcher", lastAttemptPid: 42, lastAttemptStartedAtMs: now - 60_000,
      lastAttemptAt: now - 1000, lastResult: "failed", observedStopped: false,
    }, now, cooldown), expected);
  });
}

test("loopback CDP is sufficient and background anti-throttling remains optional", () => {
  const executable = "/Applications/Codex.app/Contents/MacOS/Codex";
  const cdpFlags = [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9341",
  ].join(" ");
  const playbackFlags = [
    "--disable-background-media-suspend",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ].join(" ");
  const result = classifyCodexProcesses([
    ` 42 ${executable} ${cdpFlags}`,
    ` 47 ${executable} ${cdpFlags} ${playbackFlags}`,
    ` 43 ${executable} --remote-debugging-port=9341`,
    ` 44 ${executable} ${cdpFlags} --user-data-dir=/tmp/isolated`,
    ` 45 ${executable}.helper ${cdpFlags}`,
    ` 46 ${executable} ${cdpFlags.replace("--remote-debugging-address=127.0.0.1", "--remote-debugging-address=127.0.0.10")}`,
  ].join("\n"), executable);
  assert.deepEqual(result, {
    pids: [42, 47, 43, 46],
    compliantPids: [42, 47],
    plainPids: [43, 46],
    portsByPid: { 42: 9341, 47: 9341 },
  });
});

test("a compliant Codex repairs only a dead watcher and preserves an intentional pause", () => {
  assert.deepEqual(decideAutostartAction(snapshot(), null, now, cooldown), {
    action: "wait",
    reason: "compliant",
  });
  assert.deepEqual(
    decideAutostartAction(snapshot({ watcherState: "unhealthy" }), null, now, cooldown),
    { action: "repair-watcher", pid: 42 },
  );
  assert.deepEqual(
    decideAutostartAction(snapshot({ watcherState: "paused" }), null, now, cooldown),
    { action: "wait", reason: "paused" },
  );
});

test("a plain Codex is never restarted unless automatic restart was explicitly enabled", () => {
  const plain = snapshot({
    compliantPids: [],
    plainPids: [42],
    watcherState: "unhealthy",
  });
  assert.deepEqual(decideAutostartAction(plain, null, now, cooldown), {
    action: "wait",
    reason: "restart-not-authorized",
  });
  assert.deepEqual(
    decideAutostartAction(plain, null, now, cooldown, { allowCodexRestart: true }),
    { action: "restart", pid: 42 },
  );
});

async function withSessions(files, callback) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dream-skin-sessions-"));
  try {
    for (const [relativePath, lines] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, `${lines.join("\n")}\n`, "utf8");
    }
    return await callback(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const activityEvent = (timestamp, type) => JSON.stringify({
  timestamp: new Date(timestamp).toISOString(),
  type: "event_msg",
  payload: { type },
});

test("automatic restart is blocked while a current Codex task is active", async () => {
  await withSessions({
    "2026/09/08/active.jsonl": [activityEvent(20_000, "task_started")],
  }, async (root) => {
    assert.deepEqual(await probeSessionActivity(root, 10_000), {
      status: "busy",
      activeCount: 1,
    });
  });
  assert.deepEqual(decidePlainLaunchCorrection({ status: "busy", activeCount: 1 }), {
    allowRestart: false,
    reason: "active-task",
  });
});

test("automatic restart is allowed only after every current task is terminal", async () => {
  await withSessions({
    "2026/09/08/complete.jsonl": [
      activityEvent(20_000, "task_started"),
      activityEvent(21_000, "task_complete"),
    ],
  }, async (root) => {
    assert.deepEqual(await probeSessionActivity(root, 10_000), {
      status: "idle",
      activeCount: 0,
    });
  });
  assert.deepEqual(decidePlainLaunchCorrection({ status: "idle", activeCount: 0 }), {
    allowRestart: true,
    reason: "idle",
  });
});

test("a syntactically valid current record without lifecycle state fails closed", async () => {
  await withSessions({
    "2026/09/08/unknown.jsonl": [JSON.stringify({
      timestamp: new Date(20_000).toISOString(),
      type: "event_msg",
      payload: { type: "token_count" },
    })],
  }, async (root) => {
    assert.deepEqual(await probeSessionActivity(root, 10_000), {
      status: "unknown",
      activeCount: 0,
    });
  });
});

test("a fresh plain Codex launch receives a full startup grace period", () => {
  const plain = snapshot({
    compliantPids: [],
    plainPids: [42],
    watcherState: "unhealthy",
    appStartedAtMs: now - 1_000,
  });
  assert.deepEqual(
    decideAutostartAction(
      plain,
      null,
      now,
      cooldown,
      { allowCodexRestart: true, launchGraceMs: 60_000 },
    ),
    { action: "wait", reason: "launch-grace" },
  );
  assert.deepEqual(
    decideAutostartAction(
      { ...plain, appStartedAtMs: now - 60_001 },
      null,
      now,
      cooldown,
      { allowCodexRestart: true, launchGraceMs: 60_000 },
    ),
    { action: "restart", pid: 42 },
  );
});

test("the default startup grace corrects an authorized plain launch after ten seconds", () => {
  const plain = snapshot({
    compliantPids: [],
    plainPids: [42],
    watcherState: "unhealthy",
    appStartedAtMs: now - 9_999,
  });
  assert.deepEqual(
    decideAutostartAction(plain, null, now, cooldown, { allowCodexRestart: true }),
    { action: "wait", reason: "launch-grace" },
  );
  assert.deepEqual(
    decideAutostartAction(
      { ...plain, appStartedAtMs: now - 10_001 },
      null,
      now,
      cooldown,
      { allowCodexRestart: true },
    ),
    { action: "restart", pid: 42 },
  );
});

test("a full restart is latched until health or a real stop starts a new fault cycle", () => {
  const plain = snapshot({ compliantPids: [], plainPids: [42], watcherState: "unhealthy" });
  const latched = {
    lastAction: "restart",
    lastAttemptPid: 42,
    lastAttemptAt: now - cooldown - 1,
    lastResult: "failed",
    observedStopped: false,
  };
  assert.deepEqual(
    decideAutostartAction(plain, latched, now, cooldown, { allowCodexRestart: true }),
    { action: "wait", reason: "restart-latched" },
  );
  assert.deepEqual(
    decideAutostartAction(
      plain,
      { ...latched, observedStopped: true },
      now,
      cooldown,
      { allowCodexRestart: true },
    ),
    { action: "restart", pid: 42 },
  );
});

test("uncertain current activity fails closed and the start script rechecks before stopping Codex", async () => {
  await withSessions({
    "2026/09/08/broken.jsonl": [
      JSON.stringify({ timestamp: new Date(20_000).toISOString(), type: "event_msg", payload: { type: "token_count" } }),
      "{not-json",
    ],
  }, async (root) => {
    assert.deepEqual(await probeSessionActivity(root, 10_000), {
      status: "unknown",
      activeCount: 0,
    });
  });
  assert.deepEqual(decidePlainLaunchCorrection({ status: "unknown", activeCount: 0 }), {
    allowRestart: false,
    reason: "activity-unknown",
  });
  const startSource = fs.readFileSync(
    new URL("../scripts/start-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  const guard = startSource.indexOf("verify_automatic_restart_is_idle");
  const stop = startSource.indexOf("stop_codex true", guard);
  assert.ok(guard >= 0 && stop > guard);
  assert.match(startSource, /--activity-once/u);
});

test("a persistent native-mode intent disables every supervisor correction", () => {
  assert.deepEqual(
    decideAutostartAction(
      snapshot({ watcherState: "unhealthy", supervisorEnabled: false }),
      null,
      now,
      cooldown,
    ),
    { action: "wait", reason: "disabled" },
  );
});

test("automatic restart and the persistent disabled marker are explicit CLI capabilities", () => {
  const base = [
    "node",
    "dream-skin-autostart.mjs",
    "--once",
    "--app-executable", "/Applications/Codex.app/Contents/MacOS/Codex",
    "--start-script", "/safe/start.sh",
    "--status-script", "/safe/status.sh",
    "--state", "/safe/state.json",
    "--disabled-marker", "/safe/native.disabled",
    "--sessions-root", "/safe/sessions",
  ];
  assert.equal(parseAutostartArguments(base).allowCodexRestart, false);
  assert.equal(parseAutostartArguments(base).disabledMarker, "/safe/native.disabled");
  assert.equal(
    parseAutostartArguments([...base, "--allow-codex-restart"]).allowCodexRestart,
    true,
  );
  assert.throws(
    () => parseAutostartArguments([...base.slice(0, -4), ...base.slice(-2)]),
    /disabledMarker must be an absolute path/u,
  );
});

test("watcher status distinguishes a healthy watcher, an intentional pause, and corruption", () => {
  assert.equal(watcherStateFromStatus('{"session":"active","injectorAlive":true}'), "healthy");
  assert.equal(watcherStateFromStatus('{"session":"applying","injectorAlive":true}'), "healthy");
  assert.equal(watcherStateFromStatus('{"session":"paused","injectorAlive":false}'), "paused");
  assert.equal(watcherStateFromStatus('{"session":"active","injectorAlive":false}'), "unhealthy");
  assert.equal(
    watcherStateFromStatus('{"session":"paused","injectorAlive":true}'),
    "paused",
    "An intentional pause remains paused while its control watcher is alive.",
  );
  assert.equal(watcherStateFromStatus("not-json"), "unhealthy");
});

test("watcher repair is structurally unable to request a Codex restart", () => {
  assert.deepEqual(correctionArguments("repair-watcher", 9342), ["--repair-watcher-only", "--port", "9342"]);
  for (const invalidPort of [undefined, 0, 1023, 65536, "9342"]) {
    assert.throws(() => correctionArguments("repair-watcher", invalidPort), /port/u);
  }
  assert.deepEqual(correctionArguments("restart"), ["--restart-existing"]);
  assert.throws(() => correctionArguments("anything-else"), /Unknown correction action/u);

  const startSource = fs.readFileSync(
    new URL("../scripts/start-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  assert.match(startSource, /--repair-watcher-only\) REPAIR_WATCHER_ONLY="true"/u);
  assert.match(
    startSource,
    /if \[ "\$REPAIR_WATCHER_ONLY" = "true" \] && \[ "\$DEBUG_READY" != "true" \]; then\n  fail "Watcher-only repair requires/u,
  );
});

test("watcher health is bound to the current Codex PID even when Electron hides launch flags", () => {
  assert.equal(watcherStateFromStatus(
    '{"session":"active","injectorAlive":true,"codexPid":42}', 42,
  ), "healthy");
  assert.equal(watcherStateFromStatus(
    '{"session":"applying","injectorAlive":true,"codexPid":42}', 42,
  ), "healthy");
  assert.equal(watcherStateFromStatus(
    '{"session":"active","injectorAlive":true,"codexPid":84}', 42,
  ), "unhealthy");
});

test("status publishes the Codex PID bound to the active injector", () => {
  const statusSource = fs.readFileSync(
    new URL("../scripts/status-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  assert.match(statusSource, /CODEX_PID=/u);
  assert.match(statusSource, /"codexPid":%s/u);
});

test("status detects the real app executable instead of relying on a truncated process name", () => {
  const statusSource = fs.readFileSync(
    new URL("../scripts/status-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(statusSource, /\/usr\/bin\/pgrep -x (?:ChatGPT|Codex)/u);
  assert.match(statusSource, /\/bin\/ps -axo command=/u);
  assert.match(statusSource, /Contents\\\/MacOS\\\/\(ChatGPT\|Codex\)/u);
});

test("a healthy watcher clears the stopped marker and full-restart latch", () => {
  const source = fs.readFileSync(
    new URL("../scripts/dream-skin-autostart.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /decision\.reason === "compliant"[\s\S]*state\?\.observedStopped !== false[\s\S]*lastAction: null[\s\S]*observedStopped: false/u,
  );
});

test("recent corrections are cooled down, but failed repairs retry afterwards", () => {
  const failed = { lastAttemptPid: 42, lastAttemptAt: now - cooldown - 1, lastResult: "failed" };
  assert.deepEqual(
    decideAutostartAction(snapshot({ watcherState: "unhealthy" }), failed, now, cooldown),
    { action: "repair-watcher", pid: 42 },
  );
  assert.deepEqual(
    decideAutostartAction(
      snapshot({ watcherState: "unhealthy" }),
      { ...failed, lastAttemptAt: now - cooldown + 1 },
      now,
      cooldown,
    ),
    { action: "wait", reason: "cooldown" },
  );
});

test("a confirmed stop clears the previous correction cooldown for the next launch", () => {
  const justStopped = {
    lastAttemptPid: 42,
    lastAttemptAt: now - 1000,
    lastResult: "ok",
    observedStopped: true,
  };
  assert.deepEqual(
    decideAutostartAction(
      snapshot({ pids: [84], compliantPids: [], plainPids: [84], watcherState: "unhealthy" }),
      justStopped,
      now,
      cooldown,
      { allowCodexRestart: true },
    ),
    { action: "restart", pid: 84 },
  );
});

test("installer and uninstaller own the monitor lifecycle", () => {
  const installSource = fs.readFileSync(
    new URL("../scripts/install-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  const restoreSource = fs.readFileSync(
    new URL("../scripts/restore-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  assert.match(installSource, /install-dream-skin-autostart\.sh" install/u);
  assert.match(
    restoreSource,
    /commit_autostart_transaction\(\)[\s\S]*"\$AUTOSTART_HELPER" remove[\s\S]*"\$AUTOSTART_HELPER" disable/u,
    "Restore chooses remove only for uninstall and otherwise commits persistent disabled mode.",
  );
  assert.match(
    installSource,
    /rollback_deployed_project\(\)[\s\S]*install-dream-skin-autostart\.sh" remove[\s\S]*restore_previous_monitor/u,
    "A failed upgrade must remove the new monitor and restore the previous monitor with the previous engine.",
  );
});

test("a failed reinstall preserves the native-mode marker instead of re-enabling supervision", () => {
  const installSource = fs.readFileSync(
    new URL("../scripts/install-dream-skin-macos.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    installSource,
    /PREVIOUS_AUTOSTART_WAS_DISABLED="false"[\s\S]*AUTOSTART_DISABLED_MARKER/u,
    "The outer installer must remember persistent native mode before replacing the engine.",
  );
  assert.match(
    installSource,
    /rollback_deployed_project\(\)[\s\S]*PREVIOUS_AUTOSTART_WAS_DISABLED[\s\S]*write_native_mode_marker[\s\S]*PREVIOUS_AUTOSTART_WAS_RUNNING[\s\S]*install-dream-skin-autostart\.sh" install/u,
    "Rollback must restore native mode first and only restart a monitor that was actually running.",
  );
});
