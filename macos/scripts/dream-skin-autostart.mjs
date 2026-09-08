#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_FLAGS = [
  "--remote-debugging-address=127.0.0.1",
];
const PORT_FLAG = /(?:^|\s)--remote-debugging-port=(\d{4,5})(?=\s|$)/u;
const ISOLATED_PROFILE_FLAG = /(?:^|\s)--user-data-dir(?:=|\s)/u;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_LAUNCH_GRACE_MS = 60 * 1000;
const MAX_SESSION_TAIL_BYTES = 16 * 1024 * 1024;
const SESSION_CLOCK_TOLERANCE_MS = 2_000;
const ACTIVE_EVENT = "task_started";
const TERMINAL_EVENTS = new Set(["task_complete", "turn_aborted"]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function hasExactFlag(commandLine, flag) {
  const escaped = escapeRegExp(flag);
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, "u").test(commandLine);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyCodexProcesses(listing, executable) {
  if (!path.isAbsolute(executable || "")) throw new Error("Codex executable must be absolute");
  const exact = new RegExp(`^\\s*(\\d+)\\s+${escapeRegExp(executable)}(?=\\s|$)`);
  const entries = String(listing || "").split(/\r?\n/u).flatMap((line) => {
    const match = line.match(exact);
    if (!match || ISOLATED_PROFILE_FLAG.test(line)) return [];
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return [];
    const portMatch = line.match(PORT_FLAG);
    const port = Number(portMatch?.[1]);
    const compliant = REQUIRED_FLAGS.every((flag) => hasExactFlag(line, flag))
      && Number.isInteger(port) && port >= 1024 && port <= 65535;
    return [{ pid, compliant }];
  });
  return {
    pids: entries.map(({ pid }) => pid),
    compliantPids: entries.filter(({ compliant }) => compliant).map(({ pid }) => pid),
    plainPids: entries.filter(({ compliant }) => !compliant).map(({ pid }) => pid),
  };
}

export function watcherStateFromStatus(output, expectedCodexPid) {
  try {
    const status = JSON.parse(String(output || ""));
    if (status?.session === "paused") return "paused";
    if (status?.injectorAlive === true && new Set(["active", "applying"]).has(status?.session)
        && (!Number.isSafeInteger(expectedCodexPid) || status?.codexPid === expectedCodexPid)) {
      return "healthy";
    }
  } catch {
    // Malformed or missing status is deliberately fail-closed.
  }
  return "unhealthy";
}

export function decidePlainLaunchCorrection(activity) {
  if (activity?.status === "idle" && activity?.activeCount === 0) {
    return { allowRestart: true, reason: "idle" };
  }
  if (activity?.status === "busy") {
    return { allowRestart: false, reason: "active-task" };
  }
  return { allowRestart: false, reason: "activity-unknown" };
}

async function collectSessionFiles(root, output) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("session-tree-symlink");
    if (entry.isDirectory()) await collectSessionFiles(target, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
  }
}

async function readSessionTail(filePath, size) {
  const length = Math.min(size, MAX_SESSION_TAIL_BYTES);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    let value = buffer.subarray(0, bytesRead).toString("utf8");
    const truncated = length < size;
    if (truncated) {
      const firstNewline = value.indexOf("\n");
      value = firstNewline >= 0 ? value.slice(firstNewline + 1) : "";
    }
    return { text: value, truncated };
  } finally {
    await handle.close();
  }
}

function lifecycleEvent(record, appStartedAtMs) {
  const type = record?.type === "event_msg" ? record?.payload?.type : record?.type;
  if (type !== ACTIVE_EVENT && !TERMINAL_EVENTS.has(type)) return null;
  const timestamp = Date.parse(record?.timestamp || "");
  if (!Number.isFinite(timestamp) || timestamp < appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) {
    return null;
  }
  return { type, timestamp };
}

export async function probeSessionActivity(sessionsRoot, appStartedAtMs) {
  if (!path.isAbsolute(sessionsRoot || "") || !Number.isFinite(appStartedAtMs)) {
    return { status: "unknown", activeCount: 0 };
  }
  try {
    const rootStat = await fs.lstat(sessionsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { status: "unknown", activeCount: 0 };
    }
    const files = [];
    await collectSessionFiles(sessionsRoot, files);
    let activeCount = 0;
    let uncertain = false;
    for (const filePath of files) {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        uncertain = true;
        continue;
      }
      if (stat.mtimeMs < appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) continue;
      const { text, truncated } = await readSessionTail(filePath, stat.size);
      let latest = null;
      let sawCurrentRecord = false;
      for (const line of text.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          uncertain = true;
          continue;
        }
        const recordTimestamp = Date.parse(record?.timestamp || "");
        if (!Number.isFinite(recordTimestamp)) {
          uncertain = true;
          continue;
        }
        if (recordTimestamp >= appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) {
          sawCurrentRecord = true;
        }
        const event = lifecycleEvent(record, appStartedAtMs);
        if (event && (!latest || event.timestamp >= latest.timestamp)) latest = event;
      }
      if (latest?.type === ACTIVE_EVENT) activeCount += 1;
      else if (!latest && (truncated || sawCurrentRecord)) uncertain = true;
    }
    if (activeCount > 0) return { status: "busy", activeCount };
    if (uncertain) return { status: "unknown", activeCount: 0 };
    return { status: "idle", activeCount: 0 };
  } catch {
    return { status: "unknown", activeCount: 0 };
  }
}

export function decideAutostartAction(
  snapshot,
  state,
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  {
    allowCodexRestart = false,
    launchGraceMs = DEFAULT_LAUNCH_GRACE_MS,
  } = {},
) {
  if (!snapshot || !Array.isArray(snapshot.pids) || !Number.isFinite(now)) {
    throw new Error("Invalid autostart decision input");
  }
  if (snapshot.supervisorEnabled === false) {
    return { action: "wait", reason: "disabled" };
  }
  if (snapshot.pids.length === 0) {
    return { action: "wait", reason: "stopped", observedStopped: true };
  }
  const compliantPid = snapshot.compliantPids[0];
  if (Number.isSafeInteger(compliantPid) && snapshot.watcherState === "healthy") {
    return { action: "wait", reason: "compliant" };
  }
  if (Number.isSafeInteger(compliantPid) && snapshot.watcherState === "paused") {
    return { action: "wait", reason: "paused" };
  }
  const repairWatcher = Number.isSafeInteger(compliantPid);
  const pid = repairWatcher ? compliantPid : snapshot.plainPids[0];
  if (!Number.isSafeInteger(pid)) return { action: "wait", reason: "no-main-process" };
  if (!repairWatcher && !allowCodexRestart) {
    return { action: "wait", reason: "restart-not-authorized" };
  }
  if (!repairWatcher && Number.isFinite(snapshot.appStartedAtMs)
      && now - snapshot.appStartedAtMs < launchGraceMs) {
    return { action: "wait", reason: "launch-grace" };
  }
  if (!repairWatcher && state?.lastAction === "restart" && state?.observedStopped !== true) {
    return { action: "wait", reason: "restart-latched" };
  }
  const attemptAge = Number.isFinite(state?.lastAttemptAt) ? now - state.lastAttemptAt : Infinity;
  const sameProcessRun = state?.observedStopped !== true;
  if (sameProcessRun && state?.lastAttemptPid === pid
      && state?.lastResult === "running" && attemptAge < cooldownMs) {
    return { action: "wait", reason: "attempted-pid" };
  }
  if (sameProcessRun && Number.isFinite(state?.lastAttemptAt) && attemptAge < cooldownMs) {
    return { action: "wait", reason: "cooldown" };
  }
  return { action: repairWatcher ? "repair-watcher" : "restart", pid };
}

export function correctionArguments(action) {
  if (action === "repair-watcher") return ["--repair-watcher-only"];
  if (action === "restart") return ["--restart-existing"];
  throw new Error(`Unknown correction action: ${action}`);
}

async function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (value) => resolve(Number.isInteger(value) ? value : 1));
  });
  return { code, stdout, stderr };
}

async function processListing() {
  const result = await collectChild(spawn("/bin/ps", ["-axo", "pid=,command="], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  if (result.code !== 0) {
    throw new Error(`process-probe-failed:${result.stderr.trim() || result.code}`);
  }
  return result.stdout;
}

async function probeWatcherState(statusScript, expectedCodexPid) {
  const result = await collectChild(spawn("/bin/bash", [statusScript, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  return result.code === 0 ? watcherStateFromStatus(result.stdout, expectedCodexPid) : "unhealthy";
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await fs.readFile(statePath, "utf8"));
    return value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

async function writeState(statePath, value) {
  const directory = path.dirname(statePath);
  const temporary = `${statePath}.tmp.${process.pid}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`, {
    mode: 0o600,
    flag: "w",
  });
  await fs.rename(temporary, statePath);
  await fs.chmod(statePath, 0o600);
}

async function processStartedAt(pid) {
  const result = await collectChild(spawn("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const timestamp = result.code === 0 ? Date.parse(result.stdout.trim()) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function runCorrection(startScript, action, sessionsRoot) {
  const args = [startScript, ...correctionArguments(action)];
  if (action === "restart") {
    args.push(
      "--auto-restart-idle-only",
      "--sessions-root", sessionsRoot,
      "--activity-probe", fileURLToPath(import.meta.url),
    );
  }
  const child = spawn("/bin/bash", args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}

export function parseAutostartArguments(argv) {
  const options = {
    intervalMs: 1000,
    graceMs: 1500,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    allowCodexRestart: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") options.watch = true;
    else if (argument === "--once") options.once = true;
    else if (argument === "--activity-once") options.activityOnce = true;
    else if (argument === "--app-executable") options.executable = argv[++index];
    else if (argument === "--start-script") options.startScript = argv[++index];
    else if (argument === "--status-script") options.statusScript = argv[++index];
    else if (argument === "--state") options.statePath = argv[++index];
    else if (argument === "--disabled-marker") options.disabledMarker = argv[++index];
    else if (argument === "--sessions-root") options.sessionsRoot = argv[++index];
    else if (argument === "--app-pid") options.appPid = Number(argv[++index]);
    else if (argument === "--allow-codex-restart") options.allowCodexRestart = true;
    else if (argument === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (argument === "--grace-ms") options.graceMs = Number(argv[++index]);
    else if (argument === "--cooldown-ms") options.cooldownMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const modes = [options.watch, options.once, options.activityOnce].filter(Boolean).length;
  if (modes !== 1) throw new Error("Choose exactly one run mode");
  if (!path.isAbsolute(options.sessionsRoot || "")) throw new Error("sessionsRoot must be an absolute path");
  if (options.activityOnce) {
    if (!Number.isSafeInteger(options.appPid) || options.appPid <= 1) {
      throw new Error("appPid must be a positive process identifier");
    }
    return options;
  }
  for (const [key, value] of [
    ["executable", options.executable],
    ["startScript", options.startScript],
    ["statusScript", options.statusScript],
    ["statePath", options.statePath],
    ["disabledMarker", options.disabledMarker],
  ]) {
    if (!path.isAbsolute(value || "")) throw new Error(`${key} must be an absolute path`);
  }
  for (const value of [options.intervalMs, options.graceMs, options.cooldownMs]) {
    if (!Number.isInteger(value) || value < 100 || value > 3_600_000) {
      throw new Error("Invalid timing option");
    }
  }
  return options;
}

async function pathExists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const options = parseAutostartArguments(process.argv);
  if (options.activityOnce) {
    const startedAt = await processStartedAt(options.appPid);
    const activity = startedAt === null
      ? { status: "unknown", activeCount: 0 }
      : await probeSessionActivity(options.sessionsRoot, startedAt);
    process.stdout.write(`${JSON.stringify(activity)}\n`);
    if (!decidePlainLaunchCorrection(activity).allowRestart) process.exitCode = 3;
    return;
  }
  for (const [label, file] of [
    ["Start script", options.startScript],
    ["Status script", options.statusScript],
  ]) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  }
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });

  do {
    let state = await readState(options.statePath);
    const classified = classifyCodexProcesses(await processListing(), options.executable);
    const solePid = classified.pids.length === 1 ? classified.pids[0] : null;
    const watcherState = Number.isSafeInteger(solePid)
      ? await probeWatcherState(options.statusScript, solePid)
      : "unhealthy";
    const appStartedAtMs = Number.isSafeInteger(solePid) && watcherState !== "healthy"
      ? await processStartedAt(solePid)
      : null;
    const runtimeClassified = watcherState === "healthy" ? {
      ...classified,
      compliantPids: [solePid],
      plainPids: classified.plainPids.filter((pid) => pid !== solePid),
    } : classified;
    const snapshot = {
      ...runtimeClassified,
      supervisorEnabled: !(await pathExists(options.disabledMarker)),
      watcherState,
      appStartedAtMs,
    };
    const decision = decideAutostartAction(
      snapshot,
      state,
      Date.now(),
      options.cooldownMs,
      { allowCodexRestart: options.allowCodexRestart },
    );
    if (decision.observedStopped && state?.observedStopped !== true) {
      state = { ...(state || {}), observedStopped: true };
      await writeState(options.statePath, state);
    } else if (decision.reason === "compliant"
        && (state?.lastResult !== "ok" || state?.lastAction != null
          || state?.observedStopped !== false)) {
      state = { ...(state || {}), lastAction: null, lastResult: "ok", observedStopped: false };
      await writeState(options.statePath, state);
    } else if (decision.reason === "paused" && state?.lastResult !== "ok") {
      state = { ...(state || {}), lastResult: "ok", observedStopped: false };
      await writeState(options.statePath, state);
    } else if (["restart", "repair-watcher"].includes(decision.action)) {
      await sleep(options.graceMs);
      const confirmed = classifyCodexProcesses(await processListing(), options.executable);
      const supervisorStillEnabled = !(await pathExists(options.disabledMarker));
      const confirmedWatcherState = confirmed.pids.length === 1
        ? await probeWatcherState(options.statusScript, decision.pid)
        : "unhealthy";
      const correctionStillRequired = supervisorStillEnabled && (
        decision.action === "restart"
          ? confirmed.plainPids.includes(decision.pid) && confirmed.compliantPids.length === 0
            && confirmedWatcherState !== "healthy"
          : confirmed.compliantPids.includes(decision.pid)
            && confirmedWatcherState === "unhealthy"
      );
      if (correctionStillRequired) {
        const attemptedAt = Date.now();
        if (decision.action === "restart") {
          const startedAt = await processStartedAt(decision.pid);
          const activity = startedAt === null
            ? { status: "unknown", activeCount: 0 }
            : await probeSessionActivity(options.sessionsRoot, startedAt);
          const permission = decidePlainLaunchCorrection(activity);
          if (!permission.allowRestart) {
            await writeState(options.statePath, {
              lastAttemptPid: decision.pid,
              lastAttemptAt: attemptedAt,
              lastResult: permission.reason,
              observedStopped: false,
            });
            console.log(`[dream-skin-autostart] automatic restart deferred reason=${permission.reason}`);
            if (options.once) break;
            if (!stopping) await sleep(options.intervalMs);
            continue;
          }
        }
        await writeState(options.statePath, {
          lastAction: decision.action,
          lastAttemptPid: decision.pid,
          lastAttemptAt: attemptedAt,
          lastResult: "running",
          observedStopped: false,
        });
        console.log(`[dream-skin-autostart] ${decision.action} pid=${decision.pid}`);
        const exitCode = await runCorrection(options.startScript, decision.action, options.sessionsRoot);
        await writeState(options.statePath, {
          lastAction: decision.action,
          lastAttemptPid: decision.pid,
          lastAttemptAt: attemptedAt,
          lastResult: exitCode === 0 ? "ok" : "failed",
          observedStopped: false,
        });
        console.log(`[dream-skin-autostart] correction ${exitCode === 0 ? "ok" : "failed"}`);
      }
    }
    if (options.once) break;
    if (!stopping) await sleep(options.intervalMs);
  } while (!stopping);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[dream-skin-autostart] ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
