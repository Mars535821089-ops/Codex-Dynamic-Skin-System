#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const reservedPorts = new Set();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const ISOLATED_CODEX_STARTUP_TIMEOUT_MS = 90_000;

export function installTerminationCleanup({
  processObject = process,
  cleanup,
  onError = (error) => console.error(error?.stack || String(error)),
} = {}) {
  if (typeof cleanup !== "function") throw new Error("Termination cleanup must be a function");
  let terminationPromise = null;
  const handlers = new Map();
  const exitCodes = new Map([["SIGINT", 130], ["SIGTERM", 143]]);

  for (const [signal, exitCode] of exitCodes) {
    const handler = () => {
      if (terminationPromise) return;
      terminationPromise = Promise.resolve()
        .then(cleanup)
        .catch((error) => onError(error))
        .finally(() => processObject.exit(exitCode));
    };
    handlers.set(signal, handler);
    processObject.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) processObject.removeListener(signal, handler);
  };
}

async function freeLoopbackPort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
}

export async function createIsolation({ profileRoot = path.join(projectRoot, "work", "isolated-profiles") } = {}) {
  const resolvedRoot = path.resolve(profileRoot);
  const relativeRoot = path.relative(projectRoot, resolvedRoot);
  if (relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
    throw new Error(`Isolated profile root must stay inside the project: ${resolvedRoot}`);
  }
  await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const profilePath = await fs.mkdtemp(path.join(resolvedRoot, "codex-dream-skin-acceptance."));
  const port = await freeLoopbackPort();
  return {
    profilePath,
    port,
    args: [
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
      "--disable-background-media-suspend",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  };
}

export async function normalizeThemeDirectory(themePath) {
  const resolved = path.resolve(String(themePath || ""));
  let stats;
  try { stats = await fs.stat(resolved); } catch {
    throw new Error(`Theme path does not exist: ${resolved}`);
  }
  const directory = stats.isDirectory()
    ? resolved
    : stats.isFile() && path.basename(resolved) === "theme.json"
      ? path.dirname(resolved)
      : null;
  if (!directory) throw new Error(`Theme path must be a directory or theme.json: ${resolved}`);
  try {
    const metadata = await fs.stat(path.join(directory, "theme.json"));
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Theme directory has no theme.json: ${directory}`);
  }
  return directory;
}

export async function captureSelectionFile(selectionPath) {
  const target = path.resolve(String(selectionPath || ""));
  if (!path.isAbsolute(String(selectionPath || ""))) {
    throw new Error("Selection file path must be absolute");
  }
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: target, existed: false, bytes: null, mode: null };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Selection file must be a regular file, not a link or directory");
  }
  if (stat.size > 64 * 1024) throw new Error("Selection file is unexpectedly large");
  return {
    path: target,
    existed: true,
    bytes: await fs.readFile(target),
    mode: stat.mode & 0o777,
  };
}

export async function restoreSelectionFile(snapshot) {
  if (!snapshot?.path || !path.isAbsolute(snapshot.path)) {
    throw new Error("Selection snapshot path must be absolute");
  }
  if (!snapshot.existed) {
    try {
      await fs.unlink(snapshot.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { existed: false, restored: true };
  }
  if (!Buffer.isBuffer(snapshot.bytes)) throw new Error("Selection snapshot bytes are missing");
  const parent = path.dirname(snapshot.path);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent,
    `.selection-restore.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, snapshot.bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, snapshot.path);
    await fs.chmod(snapshot.path, snapshot.mode ?? 0o600);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return { existed: true, restored: true };
}

export function resolveInjectorPath(platform = process.platform, root = projectRoot) {
  if (platform === "darwin") return path.join(path.resolve(root), "macos", "scripts", "injector.mjs");
  if (platform === "win32") return path.join(path.resolve(root), "windows", "scripts", "injector.mjs");
  throw new Error(`Unsupported platform for isolated Codex acceptance: ${platform}`);
}

export function buildPlatformProcessProbe(platform, pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid process probe PID");
  if (platform === "darwin") {
    return { file: "/bin/ps", args: ["-p", String(pid), "-o", "command="] };
  }
  if (platform === "win32") {
    const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).CommandLine`;
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  throw new Error(`Unsupported platform for process probe: ${platform}`);
}

export function buildPlatformListenerProbe(platform, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid listener probe port");
  if (platform === "darwin") {
    return { file: "/usr/sbin/lsof", args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"] };
  }
  if (platform === "win32") {
    const command = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [Console]::WriteLine($_) }`;
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  throw new Error(`Unsupported platform for listener probe: ${platform}`);
}

export function buildPlatformIsolationProcessListProbe(platform, profilePath) {
  if (!path.isAbsolute(profilePath || "")) throw new Error("Isolated profile path must be absolute");
  if (platform === "darwin") {
    return { file: "/bin/ps", args: ["ax", "-o", "pid=,command="] };
  }
  if (platform === "win32") {
    const escapedProfile = profilePath.replaceAll("'", "''");
    const command = [
      "$profile = '" + escapedProfile + "'",
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($profile) }",
      "ForEach-Object { [Console]::WriteLine(('{0}`t{1}' -f $_.ProcessId, $_.CommandLine)) }",
    ].join("; ");
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  throw new Error(`Unsupported platform for isolation process-list probe: ${platform}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ownedIsolationPidsFromProcessList(listing, profilePath, {
  excludedPids = [],
  root = projectRoot,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedProfile = path.resolve(profilePath || "");
  const relativeProfile = path.relative(resolvedRoot, resolvedProfile);
  if (relativeProfile === ".." || relativeProfile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeProfile)) {
    throw new Error(`Isolated profile must stay inside the project: ${resolvedProfile}`);
  }
  const excluded = new Set(excludedPids.map(Number));
  const exactProfile = new RegExp(`${escapeRegExp(resolvedProfile)}(?=$|[\\s/\\\\"'])`);
  return [...new Set(String(listing || "").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    if (pid <= 1 || excluded.has(pid) || !exactProfile.test(match[2])) return [];
    return [pid];
  }))];
}

export function buildPlatformFocusProbe(platform = process.platform) {
  if (platform === "darwin") {
    return {
      file: "/usr/bin/osascript",
      args: ["-e", "tell application \"Finder\" to activate"],
      persistent: false,
    };
  }
  if (platform === "win32") {
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$form = New-Object System.Windows.Forms.Form",
      "$form.ShowInTaskbar = $false",
      "$form.TopMost = $true",
      "$form.StartPosition = 'Manual'",
      "$form.Location = New-Object System.Drawing.Point(-32000, -32000)",
      "$form.Size = New-Object System.Drawing.Size(1, 1)",
      "$form.Show()",
      "$form.Activate()",
      "[System.Windows.Forms.Application]::DoEvents()",
      "Start-Sleep -Seconds 120",
    ].join("; ");
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", command],
      persistent: true,
    };
  }
  throw new Error(`Unsupported platform for focus probe: ${platform}`);
}

export function buildOneShotInjectorArgs({ port, themeDir }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated injector port");
  if (!path.isAbsolute(themeDir || "")) throw new Error("Theme directory must be absolute");
  return [
    "--once",
    "--port", String(port),
    "--theme-dir", themeDir,
    "--background-playback-capable",
  ];
}

export function isRetryableInjectorStartupError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /No verified ChatGPT renderer[\s\S]*No page matched the expected ChatGPT shell markers/i.test(message);
}

async function injectThemeOnce({
  port,
  themeDir,
  platform = process.platform,
  startupTimeoutMs = ISOLATED_CODEX_STARTUP_TIMEOUT_MS,
}) {
  const deadline = Date.now() + startupTimeoutMs;
  for (;;) {
    await discoverTarget(port);
    try {
      await execFileAsync(process.execPath, [resolveInjectorPath(platform), ...buildOneShotInjectorArgs({ port, themeDir })], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return;
    } catch (error) {
      if (!isRetryableInjectorStartupError(error) || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

export function assertIsolatedCommand({ pid, actualPid, command, profilePath, port }) {
  if (!Number.isInteger(pid) || pid <= 1 || actualPid !== pid) {
    throw new Error(`Isolated PID mismatch: expected ${pid}, got ${actualPid}`);
  }
  const text = String(command || "");
  if (!text.includes(`--user-data-dir=${profilePath}`)) {
    throw new Error("Isolated process ignored or changed the expected profile");
  }
  if (!text.includes(`--remote-debugging-port=${port}`)) {
    throw new Error("Isolated process ignored or changed the expected debug port");
  }
  return true;
}

export function summarizeRendererSamples(samples) {
  const themeIds = [...new Set(samples.map((item) => item.themeId).filter(Boolean))];
  const generations = [...new Set(samples.map((item) => item.generation).filter(Boolean))];
  const maxRoots = Math.max(0, ...samples.map((item) => Number(item.roots) || 0));
  const maxVideos = Math.max(0, ...samples.map((item) => Number(item.videos) || 0));
  const maxEffects = Math.max(0, ...samples.map((item) => Number(item.effects) || 0));
  const times = samples.map((item) => Number(item.currentTime)).filter(Number.isFinite);
  const playbackAdvanced = times.length > 1 && Math.max(...times) - Math.min(...times) >= 0.1;
  const overlapDetected = maxRoots > 1 || maxVideos > 1 || maxEffects > 1;
  const themeJumpDetected = themeIds.length > 1 || generations.length > 1;
  const pausedSamples = samples.filter((item) => item.paused === true).length;
  const videoSamples = samples.filter((item) => (Number(item.videos) || 0) > 0).length;
  const loopSamples = samples.filter((item) => (Number(item.videos) || 0) > 0 && item.loop === true).length;
  const focusedSamples = samples.filter((item) => item.documentHasFocus === true).length;
  const unfocusedSamples = samples.filter((item) => item.documentHasFocus === false).length;
  return {
    sampleCount: samples.length,
    themeIds,
    generations,
    maxRoots,
    maxVideos,
    maxEffects,
    pausedSamples,
    videoSamples,
    loopSamples,
    loopEnabled: videoSamples > 0 && loopSamples === videoSamples,
    focusedSamples,
    unfocusedSamples,
    playbackAdvanced,
    overlapDetected,
    themeJumpDetected,
    stable: samples.length > 0 && !overlapDetected && !themeJumpDetected && maxRoots === 1 && maxVideos <= 1,
  };
}

function finiteValues(samples, read) {
  return samples.map(read).map(Number).filter(Number.isFinite);
}

function counterAdvance(samples, read) {
  const values = finiteValues(samples, read);
  return values.length > 1 ? values.at(-1) - values[0] : 0;
}

export function summarizeDynamicRuntimeSamples(samples) {
  const renderer = summarizeRendererSamples(samples);
  const declaredModuleSamples = samples.filter((sample) => Array.isArray(sample?.activeModules)).length;
  const activeModuleSets = [...new Set(samples
    .filter((sample) => Array.isArray(sample?.activeModules))
    .map((sample) => JSON.stringify([...sample.activeModules].sort())))].map((value) => JSON.parse(value));
  const completeSamples = samples.filter((sample) => sample?.modules?.media
    && sample?.modules?.performance && sample?.resources
    && typeof sample.resources === "object").length;
  const connectedSamples = samples.filter((sample) => sample?.modules?.media?.connected === true).length;
  const invalidResourceSamples = samples.filter((sample) => Object.values(sample?.resources || {})
    .some((count) => !Number.isInteger(count) || count < 0)).length;
  const tiers = [...new Set(samples.map((sample) => sample?.modules?.performance?.tier).filter(Boolean))];
  const audioSamples = samples.filter((sample) => sample?.modules?.audio).length;
  const audioExpectedSamples = samples.filter((sample) => Array.isArray(sample?.activeModules)
    && sample.activeModules.includes("audio-bus")).length;
  const audioStatuses = [...new Set(samples.map((sample) => sample?.modules?.audio?.status).filter(Boolean))];
  const voxelSamples = samples.filter((sample) => sample?.modules?.voxel).length;
  const signalSamples = samples.filter((sample) => sample?.modules?.signal).length;
  const webgl2Samples = samples.filter((sample) => sample?.modules?.voxel?.renderer === "webgl2").length;
  const contextLosses = finiteValues(samples, (sample) => sample?.modules?.voxel?.contextLosses);
  const instances = finiteValues(samples, (sample) => sample?.modules?.voxel?.instances);
  return {
    sampleCount: samples.length,
    stable: renderer.stable,
    themeIds: renderer.themeIds,
    generations: renderer.generations,
    completeSamples,
    connectedSamples,
    invalidResourceSamples,
    activeModules: { declaredSamples: declaredModuleSamples, sets: activeModuleSets },
    performance: { tiers },
    audio: { expectedSamples: audioExpectedSamples, samples: audioSamples, statuses: audioStatuses },
    voxel: {
      samples: voxelSamples,
      signalSamples,
      webgl2Samples,
      frameAdvance: counterAdvance(samples, (sample) => sample?.modules?.voxel?.frames),
      signalAdvance: counterAdvance(samples, (sample) => sample?.modules?.signal?.samples),
      maxContextLosses: contextLosses.length ? Math.max(...contextLosses) : null,
      instances: [...new Set(instances)],
    },
  };
}

export function evaluateDynamicRuntimeExpectation(summary, { requireVoxel = false } = {}) {
  const sampleCount = Number(summary?.sampleCount) || 0;
  const activeModuleContractPass = summary?.activeModules?.declaredSamples === sampleCount
    && summary?.activeModules?.sets?.length === 1;
  const audioExpectedSamples = Number(summary?.audio?.expectedSamples) || 0;
  const audioContractPass = (audioExpectedSamples === 0 && summary?.audio?.samples === 0)
    || (audioExpectedSamples === sampleCount && summary?.audio?.samples === sampleCount);
  const basePass = sampleCount > 1
    && summary?.stable === true
    && summary?.completeSamples === sampleCount
    && summary?.connectedSamples === sampleCount
    && summary?.invalidResourceSamples === 0
    && summary?.performance?.tiers?.length === 1
    && activeModuleContractPass
    && audioContractPass;
  const voxel = summary?.voxel || {};
  const voxelPass = !requireVoxel || (voxel.samples === sampleCount
    && voxel.signalSamples === sampleCount
    && voxel.webgl2Samples === sampleCount
    && voxel.frameAdvance > 0
    && voxel.signalAdvance > 0
    && voxel.maxContextLosses === 0
    && voxel.instances?.length === 1
    && voxel.instances[0] > 0);
  return { requireVoxel: Boolean(requireVoxel), pass: basePass && voxelPass };
}

const SEMANTIC_UI_SOUND_EVENTS = new Set(["taskCompleted", "approvalRequested", "taskFailed"]);

function semanticCounter(sample, eventName, field) {
  const value = Number(sample?.uiPlayback?.byEvent?.[eventName]?.[field]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function summarizeSemanticSoundSamples(samples, requiredEvents) {
  const events = [...new Set((requiredEvents || []).map(String))];
  if (events.length === 0) throw new Error("At least one semantic UI sound event is required");
  for (const eventName of events) {
    if (!SEMANTIC_UI_SOUND_EVENTS.has(eventName)) {
      throw new Error(`Unsupported semantic UI sound event: ${eventName}`);
    }
  }
  const themeIds = [...new Set(samples.map((item) => item?.themeId).filter(Boolean))];
  const generations = [...new Set(samples.map((item) => item?.generation).filter(Boolean))];
  const summarizeField = (eventName, field) => {
    const counters = samples.map((sample) => semanticCounter(sample, eventName, field));
    return {
      baseline: counters[0] ?? 0,
      final: counters.at(-1) ?? 0,
      regressed: counters.some((value, index) => index > 0 && value < counters[index - 1]),
    };
  };
  const eventEvidence = Object.fromEntries(events.map((eventName) => {
    const requested = summarizeField(eventName, "requested");
    const played = summarizeField(eventName, "played");
    const rejected = summarizeField(eventName, "rejected");
    return [eventName, {
      baselinePlayed: played.baseline,
      finalPlayed: played.final,
      playedDelta: played.final - played.baseline,
      requestedDelta: requested.final - requested.baseline,
      rejectedDelta: rejected.final - rejected.baseline,
      counterRegressed: requested.regressed || played.regressed || rejected.regressed,
    }];
  }));
  return {
    sampleCount: samples.length,
    requiredEvents: events,
    themeIds,
    generations,
    stable: samples.length > 1 && themeIds.length === 1 && generations.length === 1,
    events: eventEvidence,
  };
}

export function evaluateSemanticSoundExpectation(summary) {
  const eventEvidence = Object.values(summary?.events || {});
  const pass = Boolean(summary?.stable)
    && summary.sampleCount > 1
    && eventEvidence.length > 0
    && eventEvidence.every((event) => event.playedDelta > 0
      && event.requestedDelta > 0
      && event.rejectedDelta === 0
      && !event.counterRegressed);
  return { requiredEvents: summary?.requiredEvents || [], pass };
}

export function semanticSoundSamplingComplete(samples, requiredEvents, { confirmationSamples = 10 } = {}) {
  if (!Number.isInteger(confirmationSamples) || confirmationSamples < 1) {
    throw new Error("Semantic confirmation samples must be a positive integer");
  }
  if (!Array.isArray(samples) || samples.length < confirmationSamples + 2) return false;
  const fullSummary = summarizeSemanticSoundSamples(samples, requiredEvents);
  if (!evaluateSemanticSoundExpectation(fullSummary).pass) return false;
  const completionIndexes = fullSummary.requiredEvents.map((eventName) => {
    const baselineRequested = semanticCounter(samples[0], eventName, "requested");
    const baselinePlayed = semanticCounter(samples[0], eventName, "played");
    const baselineRejected = semanticCounter(samples[0], eventName, "rejected");
    return samples.findIndex((sample, index) => index > 0
      && semanticCounter(sample, eventName, "requested") > baselineRequested
      && semanticCounter(sample, eventName, "played") > baselinePlayed
      && semanticCounter(sample, eventName, "rejected") === baselineRejected);
  });
  if (completionIndexes.some((index) => index < 1)) return false;
  const completionIndex = Math.max(...completionIndexes);
  return samples.length - completionIndex - 1 >= confirmationSamples;
}

export function evaluatePlaybackExpectation(summary, enabled) {
  const observedInBackground = summary?.sampleCount > 0 && summary.unfocusedSamples === summary.sampleCount;
  const pass = Boolean(summary?.stable) && observedInBackground && (enabled
    ? Boolean(summary.playbackAdvanced) && summary.pausedSamples === 0
    : !summary.playbackAdvanced && summary.sampleCount > 0
      && summary.pausedSamples === summary.sampleCount);
  return { enabled: Boolean(enabled), pass };
}

export function themeSwitchAuditsPass(switchAudits) {
  return Array.isArray(switchAudits) && switchAudits.every((audit) => audit?.summary?.stable === true
    && audit.summary.playbackAdvanced === true
    && audit?.dynamicRuntimeExpectation?.pass === true);
}

const PRIVATE_KEYS = /(?:account|email|conversation|thread|message|prompt|title|url|text|content)/i;

export function redactAcceptanceReport(value, { profilePath } = {}) {
  const visit = (item, key = "") => {
    if (PRIVATE_KEYS.test(key)) return undefined;
    if (typeof item === "string") {
      return profilePath ? item.split(profilePath).join("<isolated-profile>") : item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry)).filter((entry) => entry !== undefined);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item)
        .map(([childKey, child]) => [childKey, visit(child, childKey)])
        .filter(([, child]) => child !== undefined));
    }
    return item;
  };
  return visit(value);
}

async function processCommand(pid) {
  const probe = buildPlatformProcessProbe(process.platform, pid);
  const { stdout } = await execFileAsync(probe.file, probe.args);
  return stdout.trim();
}

async function ownedIsolationPids(profilePath, platform = process.platform) {
  const probe = buildPlatformIsolationProcessListProbe(platform, profilePath);
  const { stdout } = await execFileAsync(probe.file, probe.args, { maxBuffer: 4 * 1024 * 1024 });
  return ownedIsolationPidsFromProcessList(stdout, profilePath, {
    excludedPids: [process.pid],
  });
}

async function terminateOwnedIsolationProcesses(profilePath, platform = process.platform) {
  let pids = await ownedIsolationPids(profilePath, platform);
  if (pids.length === 0) return;
  if (platform === "darwin") {
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } else if (platform === "win32") {
    const ids = pids.join(",");
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Stop-Process -Id @(${ids}) -Force -ErrorAction SilentlyContinue`]);
  } else {
    throw new Error(`Unsupported platform for isolated process cleanup: ${platform}`);
  }
  await sleep(500);
  pids = await ownedIsolationPids(profilePath, platform);
  if (platform === "darwin" && pids.length > 0) {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await sleep(250);
    pids = await ownedIsolationPids(profilePath, platform);
  }
  if (pids.length > 0) {
    throw new Error(`Could not terminate ${pids.length} process(es) owned by the isolated profile`);
  }
}

async function listenerPids(port) {
  const probe = buildPlatformListenerProbe(process.platform, port);
  const { stdout } = await execFileAsync(probe.file, probe.args);
  const pids = [...new Set(stdout.split(/\r?\n/)
    .map((line) => process.platform === "darwin" && /^p\d+$/.test(line) ? line.slice(1) : line.trim())
    .filter((line) => /^\d+$/.test(line)).map(Number))];
  if (pids.length === 0) throw new Error(`No listener found on port ${port}`);
  return pids;
}

async function focusAwayFromCodex(platform = process.platform) {
  const probe = buildPlatformFocusProbe(platform);
  if (!probe.persistent) {
    await execFileAsync(probe.file, probe.args);
    return () => {};
  }
  const focusSink = spawn(probe.file, probe.args, {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    focusSink.once("error", (error) => finish(() => reject(error)));
    focusSink.once("exit", (code) => finish(() => reject(new Error(`Focus sink exited early with code ${code}`))));
    setTimeout(() => finish(resolve), 750);
  });
  return () => {
    if (focusSink.exitCode === null && !focusSink.killed) focusSink.kill();
  };
}

async function fetchJson(port, pathname, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  async open(timeoutMs = 4000) {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await Promise.race([
      new Promise((resolve, reject) => {
        this.socket.addEventListener("open", resolve, { once: true });
        this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("CDP WebSocket timeout")), timeoutMs)),
    ]);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

export function selectCodexRendererTarget(targets) {
  const pages = Array.isArray(targets) ? targets.filter((item) =>
    item?.type === "page"
    && Boolean(item.webSocketDebuggerUrl)
    && String(item.url || "").startsWith("app://-/index.html")) : [];
  return pages.find((item) => String(item.url || "") === "app://-/index.html")
    || pages.find((item) => !String(item.url || "").includes("initialRoute=%2Favatar-overlay"))
    || null;
}

function safeRendererProbe() {
  const state = window.__CODEX_DREAM_SKIN_STATE__;
  let dynamic = null;
  try { dynamic = state?.dynamic?.diagnostics?.() || null; } catch {}
  const root = document.querySelectorAll("[data-dynamic-skin-root]");
  const videos = document.querySelectorAll("[data-dynamic-skin-video]");
  const posters = document.querySelectorAll("[data-dynamic-skin-poster]");
  const effects = document.querySelectorAll("[data-dynamic-skin-effect]");
  const video = videos[0] || null;
  const media = dynamic?.modules?.["media-layer"] || dynamic?.media || null;
  const audio = dynamic?.modules?.["audio-bus"] || dynamic?.audio || null;
  const performance = dynamic?.modules?.["performance-policy"] || null;
  const signal = dynamic?.modules?.["signal-model"] || null;
  const voxel = dynamic?.modules?.["voxel-field"] || null;
  return {
    themeId: state?.themeId || dynamic?.themeId || root[0]?.dataset?.themeId || null,
    generation: state?.revision || dynamic?.generation || dynamic?.revision || null,
    phase: dynamic?.phase || null,
    roots: root.length,
    videos: videos.length,
    posters: posters.length,
    effects: effects.length,
    paused: video ? video.paused : null,
    ended: video ? video.ended : null,
    loop: video ? video.loop : null,
    readyState: video ? video.readyState : null,
    currentTime: video ? video.currentTime : null,
    backgroundPlayback: media?.backgroundPlayback ?? null,
    backgroundPaused: media?.backgroundPaused ?? null,
    uiPlayback: audio?.uiPlayback ?? null,
    activeModules: Array.isArray(state?.dynamic?.modules) ? [...state.dynamic.modules] : null,
    modules: {
      media,
      audio,
      performance,
      signal,
      voxel,
    },
    resources: dynamic?.resources ?? null,
    documentHidden: document.hidden,
    documentHasFocus: document.hasFocus(),
  };
}

export async function discoverTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const targets = await fetchJson(port, "/json/list");
      const target = selectCodexRendererTarget(targets);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`No isolated app renderer found on port ${port}`);
}

async function setBackgroundPlayback(port, enabled) {
  const target = await discoverTarget(port);
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  try {
    const response = await cdp.call("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('[data-setting="backgroundPlayback"]');
        const save = document.querySelector('[data-skin-action="save"]');
        if (!input || !save) return { ok: false, reason: 'controls-not-found' };
        input.checked = ${enabled ? "true" : "false"};
        input.dispatchEvent(new Event('change', { bubbles: true }));
        save.click();
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem('codex.dynamicSkin.settings.v1') || 'null'); } catch {}
        return { ok: stored?.backgroundPlayback === ${enabled ? "true" : "false"}, stored: stored?.backgroundPlayback ?? null };
      })()`,
      returnByValue: true,
    });
    const result = response?.result?.value;
    if (!result?.ok) throw new Error(`Could not set background playback: ${result?.reason || "setting-not-persisted"}`);
    // Saving is a verified hot-injection transaction. Do not begin playback
    // sampling inside the legitimate old-to-new generation handoff window.
    await sleep(2500);
  } finally {
    cdp.close();
  }
}

export async function auditIsolatedRenderer({ port, expectedPid, profilePath, samples = 30, intervalMs = 100,
  requireUnfocused = false, requiredUiSounds = [], requireVoxel = false,
  semanticConfirmationSamples = 10 }) {
  const listeners = await listenerPids(port);
  if (!listeners.includes(expectedPid)) {
    throw new Error(`Expected isolated PID ${expectedPid} does not own listener ${port}; owners=${listeners.join(",")}`);
  }
  const actualPid = expectedPid;
  const command = await processCommand(actualPid);
  assertIsolatedCommand({ pid: expectedPid, actualPid, command, profilePath, port });
  const target = await discoverTarget(port);
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  const readings = [];
  try {
    if (requireUnfocused) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const response = await cdp.call("Runtime.evaluate", {
          expression: "document.hasFocus()",
          returnByValue: true,
        });
        if (response?.result?.value === false) break;
        if (Date.now() >= deadline) throw new Error("Isolated renderer did not become unfocused");
        await sleep(100);
      }
    }
    for (let index = 0; index < samples; index += 1) {
      const response = await cdp.call("Runtime.evaluate", {
        expression: `(${safeRendererProbe.toString()})()`,
        returnByValue: true,
      });
      if (response?.exceptionDetails) throw new Error("Renderer probe failed");
      readings.push(response?.result?.value || {});
      if (requiredUiSounds.length > 0 && semanticSoundSamplingComplete(readings, requiredUiSounds, {
        confirmationSamples: semanticConfirmationSamples,
      })) break;
      if (index + 1 < samples) await sleep(intervalMs);
    }
  } finally {
    cdp.close();
  }
  const report = {
    schema: "codex-dynamic-skin-isolated-acceptance/1",
    recordedAt: new Date().toISOString(),
    pid: actualPid,
    listenerPids: listeners,
    port,
    profilePath,
    command,
    summary: summarizeRendererSamples(readings),
    dynamicRuntimeSummary: summarizeDynamicRuntimeSamples(readings),
    firstSample: readings[0] || null,
    lastSample: readings.at(-1) || null,
  };
  report.dynamicRuntimeExpectation = evaluateDynamicRuntimeExpectation(report.dynamicRuntimeSummary, { requireVoxel });
  if (requiredUiSounds.length > 0) {
    report.semanticSoundSummary = summarizeSemanticSoundSamples(readings, requiredUiSounds);
    report.semanticSoundExpectation = evaluateSemanticSoundExpectation(report.semanticSoundSummary);
  }
  return report;
}

async function resolveExecutable(appPath) {
  const resolved = path.resolve(appPath);
  if (!resolved.endsWith(".app")) return resolved;
  const plist = path.join(resolved, "Contents/Info.plist");
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist]);
  return path.join(resolved, "Contents/MacOS", stdout.trim());
}

export function parseArgs(argv) {
  const options = { themes: [], requiredUiSounds: [], requireVoxel: false,
    output: "work/isolated-acceptance", samples: 50, intervalMs: 100,
    semanticConfirmationSamples: 10, keepFinalTheme: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--codex-app") options.codexApp = argv[++index];
    else if (arg === "--theme") options.themes.push(argv[++index]);
    else if (arg === "--restore-theme") options.restoreTheme = argv[++index];
    else if (arg === "--selection-file") options.selectionFile = argv[++index];
    else if (arg === "--keep-final-theme") options.keepFinalTheme = true;
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--attach-port") options.attachPort = Number(argv[++index]);
    else if (arg === "--expected-pid") options.expectedPid = Number(argv[++index]);
    else if (arg === "--profile") options.profilePath = argv[++index];
    else if (arg === "--samples") options.samples = Number(argv[++index]);
    else if (arg === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (arg === "--require-ui-sound") options.requiredUiSounds.push(argv[++index]);
    else if (arg === "--semantic-confirmation-samples") options.semanticConfirmationSamples = Number(argv[++index]);
    else if (arg === "--require-voxel") options.requireVoxel = true;
    else if (arg === "--background-playback") {
      const value = argv[++index];
      if (!['on', 'off'].includes(value)) throw new Error("--background-playback must be on or off");
      options.backgroundPlayback = value === 'on';
    }
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/isolated-codex-acceptance.mjs (--codex-app APP | --attach-port PORT --expected-pid PID --profile DIR) [--theme FILE] [--restore-theme FILE [--selection-file FILE] | --keep-final-theme] [--require-ui-sound EVENT] [--semantic-confirmation-samples N] [--require-voxel] [--output DIR]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const attachRequested = options.attachPort != null || options.expectedPid != null
    || options.profilePath != null;
  if (options.restoreTheme && options.keepFinalTheme) {
    throw new Error("--restore-theme cannot be combined with --keep-final-theme");
  }
  if (options.selectionFile && !options.restoreTheme) {
    throw new Error("--selection-file requires --restore-theme");
  }
  if (options.selectionFile && !path.isAbsolute(options.selectionFile)) {
    throw new Error("--selection-file must be absolute");
  }
  if (!attachRequested && (options.restoreTheme || options.keepFinalTheme)) {
    throw new Error("--restore-theme and --keep-final-theme are valid only in attach mode");
  }
  if (attachRequested && options.themes.length > 0 && !options.restoreTheme && !options.keepFinalTheme) {
    throw new Error("Attached theme-switch acceptance requires --restore-theme or explicit --keep-final-theme");
  }
  return options;
}

export function evaluateAttachedRestoreExpectation(summary, expectedThemeId) {
  const themeIds = Array.isArray(summary?.themeIds) ? summary.themeIds : [];
  const pass = Boolean(summary?.stable)
    && summary?.maxRoots === 1
    && summary?.overlapDetected === false
    && themeIds.length === 1
    && themeIds[0] === expectedThemeId;
  return { expectedThemeId, pass };
}

async function writeReport(report, output) {
  await fs.mkdir(output, { recursive: true });
  const redacted = redactAcceptanceReport(report, { profilePath: report.profilePath });
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  const digest = crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 12);
  const reportPath = path.join(output, `acceptance-${digest}.json`);
  await fs.writeFile(reportPath, serialized, { flag: "wx", mode: 0o600 });
  return reportPath;
}

async function main() {
  const options = parseArgs(process.argv);
  const themeDirectories = await Promise.all(options.themes.map(normalizeThemeDirectory));
  const restoreThemeDirectory = options.restoreTheme
    ? await normalizeThemeDirectory(options.restoreTheme)
    : null;
  const restoreThemeId = restoreThemeDirectory
    ? JSON.parse(await fs.readFile(path.join(restoreThemeDirectory, "theme.json"), "utf8")).id
    : null;
  if (restoreThemeDirectory && (typeof restoreThemeId !== "string" || restoreThemeId.trim() === "")) {
    throw new Error("Restore theme must declare a non-empty theme id");
  }
  const selectionSnapshot = options.selectionFile
    ? await captureSelectionFile(options.selectionFile)
    : null;
  let child = null;
  let ownedIsolation = null;
  let stopFocusSink = () => {};
  let cleanupPromise = null;
  let restorePromise = null;
  let restoreAudit = null;
  const restoreAttachedRun = () => {
    if (!restoreThemeDirectory) return Promise.resolve(null);
    if (!restorePromise) {
      restorePromise = (async () => {
        try {
          await injectThemeOnce({ port: options.attachPort, themeDir: restoreThemeDirectory });
          await sleep(500);
          const audit = await auditIsolatedRenderer({
            port: options.attachPort,
            expectedPid: options.expectedPid,
            profilePath: options.profilePath,
            samples: 10,
            intervalMs: options.intervalMs,
          });
          const expectation = evaluateAttachedRestoreExpectation(audit.summary, restoreThemeId);
          if (!expectation.pass) {
            throw new Error(`Attached renderer did not restore theme ${restoreThemeId} without overlap`);
          }
          restoreAudit = {
            themeId: restoreThemeId,
            summary: audit.summary,
            expectation,
            selection: selectionSnapshot
              ? { existedBefore: selectionSnapshot.existed, exactBytesRestored: true }
              : null,
          };
          return restoreAudit;
        } finally {
          if (selectionSnapshot) await restoreSelectionFile(selectionSnapshot);
        }
      })();
    }
    return restorePromise;
  };
  const cleanupOwnedRun = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try { stopFocusSink(); } catch {}
        if (!ownedIsolation) return;
        if (child) {
          try {
            const command = await processCommand(child.pid);
            assertIsolatedCommand({ pid: child.pid, actualPid: child.pid, command, profilePath: ownedIsolation.profilePath, port: ownedIsolation.port });
            child.kill("SIGTERM");
          } catch {}
        }
        await terminateOwnedIsolationProcesses(ownedIsolation.profilePath);
        await fs.rm(ownedIsolation.profilePath, { recursive: true, force: true });
        reservedPorts.delete(ownedIsolation.port);
      })();
    }
    return cleanupPromise;
  };
  const cleanupRun = async () => {
    try {
      await restoreAttachedRun();
    } finally {
      await cleanupOwnedRun();
    }
  };
  const removeTerminationHandlers = installTerminationCleanup({ cleanup: cleanupRun });
  try {
    if (options.attachPort) {
      if (!options.expectedPid || !options.profilePath) throw new Error("Attach mode requires --expected-pid and --profile");
    } else {
      if (!options.codexApp) throw new Error("Launch mode requires --codex-app");
      ownedIsolation = await createIsolation();
      options.attachPort = ownedIsolation.port;
      options.profilePath = ownedIsolation.profilePath;
      const executable = await resolveExecutable(options.codexApp);
      child = spawn(executable, ownedIsolation.args, { detached: false, stdio: "ignore" });
      options.expectedPid = child.pid;
    }
    const switchAudits = [];
    for (const themeDir of themeDirectories) {
      await injectThemeOnce({ port: options.attachPort, themeDir });
      await sleep(2500);
      const audit = await auditIsolatedRenderer({
        port: options.attachPort,
        expectedPid: options.expectedPid,
        profilePath: options.profilePath,
        samples: Math.max(10, Math.min(options.samples, 20)),
        intervalMs: options.intervalMs,
      });
      switchAudits.push({
        themeId: audit.summary.themeIds[0] || null,
        summary: audit.summary,
        dynamicRuntimeSummary: audit.dynamicRuntimeSummary,
        dynamicRuntimeExpectation: evaluateDynamicRuntimeExpectation(audit.dynamicRuntimeSummary,
          { requireVoxel: false }),
      });
    }
    if (typeof options.backgroundPlayback === "boolean") {
      await setBackgroundPlayback(options.attachPort, options.backgroundPlayback);
      stopFocusSink = await focusAwayFromCodex();
      await sleep(500);
    }
    const report = await auditIsolatedRenderer({
      port: options.attachPort,
      expectedPid: options.expectedPid,
      profilePath: options.profilePath,
      samples: options.samples,
      intervalMs: options.intervalMs,
      requireUnfocused: typeof options.backgroundPlayback === "boolean",
      requiredUiSounds: options.requiredUiSounds,
      requireVoxel: options.requireVoxel,
      semanticConfirmationSamples: options.semanticConfirmationSamples,
    });
    report.requestedThemes = options.themes.map((theme) => path.basename(theme));
    report.switchAudits = switchAudits;
    if (typeof options.backgroundPlayback === "boolean") {
      report.playbackExpectation = evaluatePlaybackExpectation(report.summary, options.backgroundPlayback);
    }
    if (restoreThemeDirectory) {
      await restoreAttachedRun();
      report.restoreAudit = restoreAudit;
    }
    const reportPath = await writeReport(report, path.resolve(options.output));
    console.log(JSON.stringify({
      reportPath,
      summary: report.summary,
      dynamicRuntimeSummary: report.dynamicRuntimeSummary,
      dynamicRuntimeExpectation: report.dynamicRuntimeExpectation,
    }, null, 2));
    const switchedThemesPass = themeSwitchAuditsPass(switchAudits);
    const playbackPass = report.playbackExpectation?.pass
      ?? (report.summary.stable && report.summary.playbackAdvanced);
    const semanticSoundPass = report.semanticSoundExpectation?.pass ?? true;
    const pass = switchedThemesPass && playbackPass && semanticSoundPass
      && report.dynamicRuntimeExpectation.pass;
    if (!pass) process.exitCode = 1;
  } finally {
    try {
      await cleanupRun();
    } finally {
      removeTerminationHandlers();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
