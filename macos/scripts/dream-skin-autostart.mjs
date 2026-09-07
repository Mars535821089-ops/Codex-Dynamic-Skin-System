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

export function watcherStateFromStatus(output) {
  try {
    const status = JSON.parse(String(output || ""));
    if (status?.session === "paused") return "paused";
    if (status?.injectorAlive === true && new Set(["active", "applying"]).has(status?.session)) {
      return "healthy";
    }
  } catch {
    // Malformed or missing status is deliberately fail-closed.
  }
  return "unhealthy";
}

export function decideAutostartAction(
  snapshot,
  state,
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  { allowCodexRestart = false } = {},
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

async function probeWatcherState(statusScript) {
  const result = await collectChild(spawn("/bin/bash", [statusScript, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  return result.code === 0 ? watcherStateFromStatus(result.stdout) : "unhealthy";
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

async function runCorrection(startScript, action) {
  const child = spawn("/bin/bash", [startScript, ...correctionArguments(action)], {
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
    else if (argument === "--app-executable") options.executable = argv[++index];
    else if (argument === "--start-script") options.startScript = argv[++index];
    else if (argument === "--status-script") options.statusScript = argv[++index];
    else if (argument === "--state") options.statePath = argv[++index];
    else if (argument === "--disabled-marker") options.disabledMarker = argv[++index];
    else if (argument === "--allow-codex-restart") options.allowCodexRestart = true;
    else if (argument === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (argument === "--grace-ms") options.graceMs = Number(argv[++index]);
    else if (argument === "--cooldown-ms") options.cooldownMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.watch === options.once) throw new Error("Choose exactly one of --watch or --once");
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
    const snapshot = {
      ...classified,
      supervisorEnabled: !(await pathExists(options.disabledMarker)),
      watcherState: classified.compliantPids.length > 0
        ? await probeWatcherState(options.statusScript)
        : "unhealthy",
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
    } else if (["compliant", "paused"].includes(decision.reason) && state?.lastResult !== "ok") {
      state = { ...(state || {}), lastResult: "ok", observedStopped: false };
      await writeState(options.statePath, state);
    } else if (["restart", "repair-watcher"].includes(decision.action)) {
      await sleep(options.graceMs);
      const confirmed = classifyCodexProcesses(await processListing(), options.executable);
      const supervisorStillEnabled = !(await pathExists(options.disabledMarker));
      const correctionStillRequired = supervisorStillEnabled && (
        decision.action === "restart"
          ? confirmed.plainPids.includes(decision.pid) && confirmed.compliantPids.length === 0
          : confirmed.compliantPids.includes(decision.pid)
            && await probeWatcherState(options.statusScript) === "unhealthy"
      );
      if (correctionStillRequired) {
        const attemptedAt = Date.now();
        await writeState(options.statePath, {
          lastAttemptPid: decision.pid,
          lastAttemptAt: attemptedAt,
          lastResult: "running",
          observedStopped: false,
        });
        console.log(`[dream-skin-autostart] ${decision.action} pid=${decision.pid}`);
        const exitCode = await runCorrection(options.startScript, decision.action);
        await writeState(options.statePath, {
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
