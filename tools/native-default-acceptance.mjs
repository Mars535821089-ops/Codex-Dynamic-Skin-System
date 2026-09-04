#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CdpSession,
  auditIsolatedRenderer,
  createIsolation,
  discoverTarget,
  normalizeThemeDirectory,
} from "./isolated-codex-acceptance.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsEvidenceRoot = path.join(projectRoot, "work", "windows-native-acceptance");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const options = { codexApp: "/Applications/Codex.app", theme: null, attachPort: null,
    expectedPid: null, profilePath: null, selectionFile: null, output: null };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex-app") options.codexApp = argv[++index];
    else if (argument === "--theme") options.theme = argv[++index];
    else if (argument === "--attach-port") options.attachPort = Number(argv[++index]);
    else if (argument === "--expected-pid") options.expectedPid = Number(argv[++index]);
    else if (argument === "--profile") options.profilePath = argv[++index];
    else if (argument === "--selection-file") options.selectionFile = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.theme) {
    throw new Error("Usage: native-default-acceptance.mjs --theme DIR [--codex-app APP | --attach-port PORT --expected-pid PID --profile DIR --selection-file FILE --output FILE]");
  }
  const attachRequested = options.attachPort != null || options.expectedPid != null
    || options.profilePath != null || options.selectionFile != null || options.output != null;
  if (attachRequested) {
    if (!Number.isInteger(options.attachPort) || options.attachPort < 1024 || options.attachPort > 65535) {
      throw new Error("Attach mode requires --attach-port between 1024 and 65535");
    }
    if (!Number.isInteger(options.expectedPid) || options.expectedPid <= 1) {
      throw new Error("Attach mode requires --expected-pid greater than 1");
    }
    for (const [name, value] of [["--profile", options.profilePath],
      ["--selection-file", options.selectionFile], ["--output", options.output]]) {
      if (!value || !path.isAbsolute(value)) throw new Error(`Attach mode requires absolute ${name}`);
    }
    options.attach = true;
  } else {
    options.attach = false;
  }
  return options;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function writeEvidenceReport(report, outputPath) {
  const target = path.resolve(outputPath);
  if (!isInside(windowsEvidenceRoot, target)) {
    throw new Error(`Output must stay inside the project-owned Windows acceptance root: ${windowsEvidenceRoot}`);
  }
  await fs.mkdir(windowsEvidenceRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(windowsEvidenceRoot,
    `.native-default-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await fs.link(temporary, target);
    await fs.unlink(temporary);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

async function resolveExecutable(appPath) {
  const resolved = path.resolve(appPath);
  if (!resolved.endsWith(".app")) return resolved;
  const plist = path.join(resolved, "Contents", "Info.plist");
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract", "CFBundleExecutable", "raw", "-o", "-", plist,
  ]);
  return path.join(resolved, "Contents", "MacOS", stdout.trim());
}

async function terminateProfileProcesses(profilePath) {
  let listing = "";
  try {
    ({ stdout: listing } = await execFileAsync("/bin/ps", ["ax", "-o", "pid=,command="]));
  } catch {
    return;
  }
  const ownedPids = listing.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !match[2].includes(profilePath)) return [];
    const pid = Number(match[1]);
    return pid > 1 && pid !== process.pid ? [pid] : [];
  });
  for (const pid of ownedPids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

const STATE_EXPRESSION = `(() => {
  const state = window.__CODEX_DREAM_SKIN_STATE__;
  const nativeState = window.__CODEX_DYNAMIC_SKIN_NATIVE_STATE__;
  const video = document.querySelector('[data-dynamic-skin-video]');
  return {
    themeId: state?.themeId ?? nativeState?.themeId ?? null,
    generation: state?.generation ?? nativeState?.generation ?? null,
    native: nativeState?.displayMode === "native" && nativeState?.activation === "active",
    roots: document.querySelectorAll('[data-dynamic-skin-root]').length,
    videos: document.querySelectorAll('[data-dynamic-skin-video]').length,
    posters: document.querySelectorAll('[data-dynamic-skin-poster]').length,
    effects: document.querySelectorAll('[data-dynamic-skin-effect]').length,
    styles: document.querySelectorAll('#codex-dream-skin-style').length,
    controls: document.querySelectorAll('[data-dynamic-skin-controls]').length,
    displayMode: nativeState?.displayMode ?? state?.displayMode ?? null,
    videoTime: video?.currentTime ?? null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    videoPaused: video?.paused ?? null,
    videoLoop: video?.loop ?? null,
  };
})()`;

async function main() {
  const options = parseArgs(process.argv);
  const sourceTheme = await normalizeThemeDirectory(options.theme);
  const themeMetadata = JSON.parse(await fs.readFile(path.join(sourceTheme, "theme.json"), "utf8"));
  const isolation = options.attach
    ? { profilePath: path.resolve(options.profilePath), port: options.attachPort, args: [] }
    : await createIsolation();
  const library = path.join(isolation.profilePath, "theme-library");
  const themeDir = options.attach ? sourceTheme : path.join(library, "acceptance-theme");
  const settings = path.join(isolation.profilePath, "settings.json");
  if (!options.attach) {
    await fs.mkdir(library, { recursive: true, mode: 0o700 });
    await fs.cp(sourceTheme, themeDir, { recursive: true });
  }

  let app = null;
  let watcher = null;
  let cdp = null;
  let watcherLog = "";
  const cleanup = async () => {
    try { cdp?.close(); } catch {}
    if (options.attach) return;
    try { watcher?.kill("SIGTERM"); } catch {}
    try { app?.kill("SIGTERM"); } catch {}
    await sleep(800);
    await terminateProfileProcesses(isolation.profilePath);
    await sleep(500);
    await fs.rm(isolation.profilePath, { recursive: true, force: true });
  };
  const evaluate = async (expression) => {
    const response = await cdp.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response?.exceptionDetails) throw new Error("Renderer evaluation failed");
    return response?.result?.value;
  };
  const waitFor = async (label, probe, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await probe().catch((error) => ({ error: error.message }));
      if (last?.pass) return last;
      await sleep(250);
    }
    const watcherTail = watcherLog.split(/\r?\n/).filter(Boolean).slice(-8);
    throw new Error(`${label} timed out: ${JSON.stringify(last)}; watcher=${JSON.stringify(watcherTail)}`);
  };

  try {
    let binding = null;
    if (options.attach) {
      binding = await auditIsolatedRenderer({
        port: isolation.port,
        expectedPid: options.expectedPid,
        profilePath: isolation.profilePath,
        samples: 2,
        intervalMs: 100,
      });
    } else {
      app = spawn(await resolveExecutable(options.codexApp), isolation.args, { stdio: "ignore" });
      watcher = spawn(process.execPath, [
        path.join(projectRoot, "macos", "scripts", "injector.mjs"),
        "--watch", "--port", String(isolation.port),
        "--theme-dir", themeDir,
        "--theme-library", library,
        "--settings", settings,
        "--background-playback-capable",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const appendLog = (chunk) => { watcherLog = `${watcherLog}${chunk}`.slice(-8000); };
      watcher.stdout.on("data", appendLog);
      watcher.stderr.on("data", appendLog);
    }

    const target = await discoverTarget(isolation.port, 90_000);
    cdp = new CdpSession(target.webSocketDebuggerUrl);
    await cdp.open();
    const initial = await waitFor("initial theme", async () => {
      const value = await evaluate(STATE_EXPRESSION);
      return { ...value, pass: value.roots === 1 && value.controls === 1 && !value.native };
    }, 90_000);

    const restoreClicked = await evaluate(`(() => {
      const button = document.querySelector('[data-dynamic-skin-controls] [data-skin-action="restore-default-theme"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!restoreClicked) throw new Error("Restore-default button was not found");
    const native = await waitFor("native mode", async () => {
      const value = await evaluate(STATE_EXPRESSION);
      return { ...value, pass: value.native && value.displayMode === "native"
        && value.roots === 0 && value.videos === 0 && value.posters === 0
        && value.effects === 0 && value.styles === 0 && value.controls === 1 };
    });
    const selectionFile = options.attach
      ? path.resolve(options.selectionFile)
      : path.join(isolation.profilePath, "selected-theme.json");
    const persistedNative = JSON.parse(await fs.readFile(selectionFile, "utf8"));

    await cdp.call("Page.reload", { ignoreCache: true });
    const nativeAfterReload = await waitFor("native mode after reload", async () => {
      const value = await evaluate(STATE_EXPRESSION);
      return { ...value, pass: value.native && value.roots === 0 && value.videos === 0
        && value.posters === 0 && value.effects === 0 && value.styles === 0 && value.controls === 1 };
    }, 60_000);

    const themeId = JSON.stringify(themeMetadata.id);
    const reappliedClicked = await evaluate(`(() => {
      const host = document.querySelector('[data-dynamic-skin-controls]');
      const card = [...(host?.querySelectorAll('[data-theme-id]') ?? [])]
        .find((item) => item.getAttribute('data-theme-id') === ${themeId});
      const save = host?.querySelector('[data-skin-action="save"]');
      if (!card || !save) return false;
      card.click();
      save.click();
      return true;
    })()`);
    if (!reappliedClicked) throw new Error("Theme card or save button was not found in native mode");
    const reapplied = await waitFor("theme reapplied", async () => {
      const value = await evaluate(STATE_EXPRESSION);
      return { ...value, pass: !value.native && value.roots === 1 && value.videos === 1
        && value.controls === 1 && value.videoLoop === true && value.videoPaused === false };
    });
    const persistedTheme = await waitFor("theme selection persisted", async () => {
      const value = JSON.parse(await fs.readFile(selectionFile, "utf8"));
      return { ...value, pass: value.themeId === themeMetadata.id && value.mode === "theme" };
    });

    await cdp.call("Page.reload", { ignoreCache: true });
    const reappliedAfterReload = await waitFor("reapplied theme after reload", async () => {
      const value = await evaluate(STATE_EXPRESSION);
      return { ...value, pass: !value.native && value.roots === 1 && value.videos === 1
        && value.controls === 1 && value.videoLoop === true && value.videoPaused === false };
    }, 60_000);
    const playbackBefore = await evaluate(STATE_EXPRESSION);
    await sleep(1500);
    const playbackAfter = await evaluate(STATE_EXPRESSION);
    const wrapped = Number.isFinite(playbackBefore.videoDuration)
      && playbackBefore.videoTime > playbackBefore.videoDuration - 1.5
      && playbackAfter.videoTime < playbackBefore.videoTime;
    const playbackAdvanced = wrapped
      || playbackAfter.videoTime > playbackBefore.videoTime + 0.15;
    if (!playbackAdvanced || playbackAfter.videoPaused || playbackAfter.videoLoop !== true) {
      throw new Error(`reapplied video did not advance: ${JSON.stringify({ playbackBefore, playbackAfter })}`);
    }

    const report = {
      schema: "codex-dynamic-skin-native-default-round-trip/1",
      pass: true,
      recordedAt: new Date().toISOString(),
      attachMode: options.attach,
      isolatedProfileOwned: !options.attach,
      binding: binding ? {
        pid: binding.pid,
        listenerPids: binding.listenerPids,
        port: binding.port,
        dynamicRuntimeExpectation: binding.dynamicRuntimeExpectation,
      } : null,
      themeId: themeMetadata.id,
      initial,
      native,
      persistedNative,
      nativeAfterReload,
      reapplied,
      persistedTheme,
      reappliedAfterReload,
      playbackBefore,
      playbackAfter,
      playbackAdvanced,
      watcherTail: watcherLog.split(/\r?\n/).filter(Boolean).slice(-8),
    };
    if (options.output) {
      const reportPath = await writeEvidenceReport(report, options.output);
      console.log(JSON.stringify({ pass: true, reportPath }, null, 2));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
