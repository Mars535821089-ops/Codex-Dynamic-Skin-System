import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ISOLATED_CODEX_STARTUP_TIMEOUT_MS,
  assertIsolatedCommand,
  createIsolation,
  evaluateSemanticSoundExpectation,
  evaluateDynamicRuntimeExpectation,
  evaluateAttachedRestoreExpectation,
  evaluatePlaybackExpectation,
  installTerminationCleanup,
  isRetryableInjectorStartupError,
  normalizeThemeDirectory,
  ownedIsolationPidsFromProcessList,
  buildOneShotInjectorArgs,
  captureSelectionFile,
  parseArgs,
  restoreSelectionFile,
  buildPlatformIsolationProcessListProbe,
  buildPlatformListenerProbe,
  buildPlatformProcessProbe,
  buildPlatformFocusProbe,
  redactAcceptanceReport,
  resolveInjectorPath,
  selectCodexRendererTarget,
  semanticSoundSamplingComplete,
  summarizeSemanticSoundSamples,
  summarizeDynamicRuntimeSamples,
  summarizeRendererSamples,
  themeSwitchAuditsPass,
} from "../isolated-codex-acceptance.mjs";
import { nativeDefaultCleanupPidsFromProcessList } from "../native-default-acceptance.mjs";

test("attached theme-switch acceptance requires an explicit post-test outcome", () => {
  const attach = [
    "node", "tool",
    "--attach-port", "64153",
    "--expected-pid", "75626",
    "--profile", "/tmp/codex-second-profile",
    "--theme", "/tmp/acceptance-video",
  ];

  assert.throws(() => parseArgs(attach), /--restore-theme.*--keep-final-theme/i);
  assert.equal(parseArgs([...attach, "--restore-theme", "/tmp/original-theme"]).restoreTheme,
    "/tmp/original-theme");
  assert.equal(parseArgs([
    ...attach,
    "--restore-theme", "/tmp/original-theme",
    "--selection-file", "/tmp/selected-theme.json",
  ]).selectionFile, "/tmp/selected-theme.json");
  assert.equal(parseArgs([...attach, "--keep-final-theme"]).keepFinalTheme, true);
  assert.throws(
    () => parseArgs([...attach, "--restore-theme", "/tmp/original-theme", "--keep-final-theme"]),
    /cannot be combined/i,
  );
});

test("restores an existing selection file byte for byte", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection."));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "selected-theme.json");
  const original = Buffer.from('{\n  "themeId" : "original.theme",\n  "mode":"theme"\n}\n');
  await fs.writeFile(target, original, { mode: 0o640 });
  const snapshot = await captureSelectionFile(target);

  await fs.writeFile(target, '{"themeId":"acceptance.video-gold"}\n');
  await restoreSelectionFile(snapshot);

  assert.deepEqual(await fs.readFile(target), original);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
});

test("restores an absent selection file to the absent state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection."));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "selected-theme.json");
  const snapshot = await captureSelectionFile(target);

  await fs.writeFile(target, '{"themeId":"acceptance.video-gold"}\n');
  await restoreSelectionFile(snapshot);

  await assert.rejects(() => fs.access(target), /ENOENT/);
});

test("attached read-only audits do not require a theme restore", () => {
  const options = parseArgs([
    "node", "tool",
    "--attach-port", "64153",
    "--expected-pid", "75626",
    "--profile", "/tmp/codex-second-profile",
  ]);
  assert.equal(options.restoreTheme, undefined);
  assert.equal(options.keepFinalTheme, false);
});

test("accepts an attached restore only when the original theme is uniquely stable", () => {
  const stable = {
    stable: true,
    maxRoots: 1,
    overlapDetected: false,
    themeIds: ["original.theme"],
  };
  assert.equal(evaluateAttachedRestoreExpectation(stable, "original.theme").pass, true);
  assert.equal(evaluateAttachedRestoreExpectation({ ...stable, maxRoots: 2 }, "original.theme").pass, false);
  assert.equal(evaluateAttachedRestoreExpectation({ ...stable, themeIds: ["test.theme"] }, "original.theme").pass, false);
});

test("waits for one owned cleanup before exiting on repeated termination signals", async () => {
  const fakeProcess = new EventEmitter();
  const exitCodes = [];
  let cleanupCalls = 0;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const exited = new Promise((resolve) => {
    fakeProcess.exit = (code) => {
      exitCodes.push(code);
      resolve();
    };
  });

  const dispose = installTerminationCleanup({
    processObject: fakeProcess,
    cleanup: async () => {
      cleanupCalls += 1;
      await cleanupGate;
    },
  });

  fakeProcess.emit("SIGINT");
  fakeProcess.emit("SIGTERM");
  await Promise.resolve();
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(exitCodes, [], "the process must stay alive until cleanup finishes");

  releaseCleanup();
  await exited;
  assert.deepEqual(exitCodes, [130], "the first termination signal owns the exit code");

  dispose();
  assert.equal(fakeProcess.listenerCount("SIGINT"), 0);
  assert.equal(fakeProcess.listenerCount("SIGTERM"), 0);
});

test("a successful CDP open does not keep the audit process alive until its timeout", async (t) => {
  const moduleUrl = new URL("../isolated-codex-acceptance.mjs", import.meta.url).href;
  const source = [
    "class FakeWebSocket extends EventTarget {",
    "  static OPEN = 1;",
    "  constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }",
    "  send() {}",
    "  close() { this.readyState = 3; }",
    "}",
    "globalThis.WebSocket = FakeWebSocket;",
    `const { CdpSession } = await import(${JSON.stringify(moduleUrl)});`,
    "const session = new CdpSession('ws://isolated.test');",
    "await session.open(2_000);",
    "session.close();",
  ].join("\n");
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });

  const result = await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 750)),
  ]);
  if (result.timedOut) child.kill("SIGKILL");

  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(performance.now() - startedAt < 750, "successful open retained its timeout timer");
});

test("a CDP call can reject a renderer that never answers", async (t) => {
  const moduleUrl = new URL("../isolated-codex-acceptance.mjs", import.meta.url).href;
  const source = [
    "class FakeWebSocket extends EventTarget {",
    "  static OPEN = 1;",
    "  constructor() { super(); this.readyState = 1; }",
    "  send() {}",
    "  close() { this.readyState = 3; }",
    "}",
    "globalThis.WebSocket = FakeWebSocket;",
    `const { CdpSession } = await import(${JSON.stringify(moduleUrl)});`,
    "const session = new CdpSession('ws://isolated.test');",
    "try {",
    "  await session.call('Runtime.evaluate', {}, 25);",
    "  process.exitCode = 2;",
    "} catch (error) {",
    "  if (!/CDP call timed out/.test(String(error?.message))) process.exitCode = 3;",
    "} finally { session.close(); }",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });

  const result = await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 750)),
  ]);
  if (result.timedOut) child.kill("SIGKILL");
  assert.deepEqual(result, { code: 0, signal: null });
});

test("removes project-owned state before a real SIGINT exits the process", async (t) => {
  const root = path.join(os.tmpdir(), "codex-dynamic-skin-test-signal-cleanup");
  await fs.mkdir(root, { recursive: true });
  const profilePath = await fs.mkdtemp(path.join(root, "profile."));
  await fs.writeFile(path.join(profilePath, "owned-marker"), "owned\n");
  const moduleUrl = new URL("../isolated-codex-acceptance.mjs", import.meta.url).href;
  const source = [
    `import fs from ${JSON.stringify("node:fs/promises")};`,
    `import { installTerminationCleanup } from ${JSON.stringify(moduleUrl)};`,
    `const profilePath = ${JSON.stringify(profilePath)};`,
    "installTerminationCleanup({ cleanup: () => fs.rm(profilePath, { recursive: true, force: true }) });",
    "console.log('ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  });

  await once(child.stdout, "data");
  assert.equal(child.kill("SIGINT"), true);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 130);
  assert.equal(signal, null);
  await assert.rejects(() => fs.access(profilePath), /ENOENT/);
});

test("accepts complete dynamic runtime diagnostics only in one stable generation", () => {
  const samples = [4, 12].map((frames, index) => ({
    themeId: "mars.voxel",
    generation: "g1",
    roots: 1,
    videos: 0,
    effects: 1,
    activeModules: ["controller", "media-layer", "audio-bus", "performance-policy", "signal-model", "voxel-field"],
    modules: {
      media: { mode: "effect", fit: "cover", tier: "full", connected: true },
      audio: { status: "ready", unlocked: true, gains: { master: 0.8, ambient: 0.5, ui: 0.7 } },
      performance: { tier: "full", reducedMotion: false },
      signal: { source: "ambient", bands: 32, samples: 20 + index },
      voxel: { phase: "active", renderer: "webgl2", frames, contextLosses: 0, tier: "full", instances: 2304 },
    },
    resources: { listener: 7, element: 3, "object-url": 2 },
  }));

  const summary = summarizeDynamicRuntimeSamples(samples);
  assert.equal(summary.stable, true);
  assert.equal(summary.voxel.frameAdvance, 8);
  assert.equal(summary.voxel.signalAdvance, 1);
  assert.equal(summary.voxel.webgl2Samples, 2);
  assert.deepEqual(summary.performance.tiers, ["full"]);
  assert.equal(evaluateDynamicRuntimeExpectation(summary, { requireVoxel: true }).pass, true);
});

test("accepts an audio-free theme when its active module contract omits audio-bus", () => {
  const base = {
    themeId: "mars.image-only",
    generation: "g1",
    roots: 1,
    videos: 0,
    effects: 0,
    activeModules: ["controller", "media-layer", "performance-policy"],
    modules: {
      media: { mode: "image", fit: "cover", tier: "full", connected: true },
      audio: null,
      performance: { tier: "full", reducedMotion: false },
      signal: null,
      voxel: null,
    },
    resources: { listener: 2, element: 1 },
  };

  const summary = summarizeDynamicRuntimeSamples([base, structuredClone(base)]);
  assert.equal(summary.audio.expectedSamples, 0);
  assert.equal(summary.audio.samples, 0);
  assert.equal(evaluateDynamicRuntimeExpectation(summary).pass, true);
});

test("rejects missing, overlapping, stalled, degraded, or leaking runtime diagnostics", () => {
  const base = {
    themeId: "mars.voxel",
    generation: "g1",
    roots: 1,
    videos: 0,
    effects: 1,
    activeModules: ["controller", "media-layer", "audio-bus", "performance-policy", "signal-model", "voxel-field"],
    modules: {
      media: { mode: "effect", fit: "cover", tier: "full", connected: true },
      audio: { status: "ready", unlocked: false, gains: { master: 0, ambient: 0, ui: 0 } },
      performance: { tier: "full", reducedMotion: false },
      signal: { source: "procedural", bands: 32, samples: 3 },
      voxel: { phase: "active", renderer: "webgl2", frames: 4, contextLosses: 0, tier: "full", instances: 2304 },
    },
    resources: { listener: 7 },
  };
  const stalled = summarizeDynamicRuntimeSamples([base, structuredClone(base)]);
  assert.equal(evaluateDynamicRuntimeExpectation(stalled, { requireVoxel: true }).pass, false);

  const overlap = structuredClone(base);
  overlap.roots = 2;
  overlap.effects = 2;
  overlap.modules.voxel.frames = 12;
  overlap.modules.signal.samples = 8;
  const overlapping = summarizeDynamicRuntimeSamples([base, overlap]);
  assert.equal(evaluateDynamicRuntimeExpectation(overlapping, { requireVoxel: true }).pass, false);

  const fallback = structuredClone(overlap);
  fallback.roots = 1;
  fallback.effects = 1;
  fallback.modules.voxel.renderer = "fallback";
  const degraded = summarizeDynamicRuntimeSamples([base, fallback]);
  assert.equal(evaluateDynamicRuntimeExpectation(degraded, { requireVoxel: true }).pass, false);

  const invalidResource = structuredClone(overlap);
  invalidResource.roots = 1;
  invalidResource.effects = 1;
  invalidResource.resources.listener = -1;
  const leaking = summarizeDynamicRuntimeSamples([base, invalidResource]);
  assert.equal(leaking.invalidResourceSamples, 1);
  assert.equal(evaluateDynamicRuntimeExpectation(leaking, { requireVoxel: true }).pass, false);

  const missing = summarizeDynamicRuntimeSamples([{ ...base, modules: null }, { ...base, modules: null }]);
  assert.equal(evaluateDynamicRuntimeExpectation(missing).pass, false);

  const missingAudioSample = structuredClone(overlap);
  missingAudioSample.roots = 1;
  missingAudioSample.effects = 1;
  delete missingAudioSample.modules.audio;
  const missingAudio = summarizeDynamicRuntimeSamples([base, missingAudioSample]);
  assert.equal(evaluateDynamicRuntimeExpectation(missingAudio).pass, false);
});

test("selects the platform injector without crossing project boundaries", () => {
  const projectRoot = path.resolve("/project/Codex Dynamic Skin System");
  assert.equal(resolveInjectorPath("darwin", projectRoot),
    path.join(projectRoot, "macos", "scripts", "injector.mjs"));
  assert.equal(resolveInjectorPath("win32", projectRoot),
    path.join(projectRoot, "windows", "scripts", "injector.mjs"));
  assert.throws(() => resolveInjectorPath("linux", projectRoot), /unsupported platform/i);
});

test("builds native Windows process and listener probes without macOS tools", () => {
  const processProbe = buildPlatformProcessProbe("win32", 43210);
  const listenerProbe = buildPlatformListenerProbe("win32", 19443);
  const serialized = JSON.stringify([processProbe, listenerProbe]);

  assert.equal(processProbe.file, "powershell.exe");
  assert.equal(listenerProbe.file, "powershell.exe");
  assert.match(processProbe.args.join(" "), /Win32_Process/);
  assert.match(listenerProbe.args.join(" "), /Get-NetTCPConnection/);
  assert.equal(serialized.includes("/bin/ps"), false);
  assert.equal(serialized.includes("/usr/sbin/lsof"), false);
});

test("keeps Darwin probes explicit and fail-closed", () => {
  assert.deepEqual(buildPlatformProcessProbe("darwin", 43210), {
    file: "/bin/ps",
    args: ["-p", "43210", "-o", "command="],
  });
  assert.deepEqual(buildPlatformListenerProbe("darwin", 19443), {
    file: "/usr/sbin/lsof",
    args: ["-nP", "-iTCP:19443", "-sTCP:LISTEN", "-Fp"],
  });
  assert.throws(() => buildPlatformProcessProbe("linux", 2), /unsupported platform/i);
});

test("finds only processes owned by the exact project-isolated profile", () => {
  const root = "/project/Codex Dynamic Skin System";
  const profilePath = `${root}/work/isolated-profiles/codex-dream-skin-acceptance.safe`;
  const listing = [
    ` 410 /Applications/ChatGPT.app/Contents/MacOS/Codex --user-data-dir=${profilePath} --remote-debugging-port=19443`,
    ` 411 /Applications/ChatGPT.app/Helpers/browser_crashpad_handler --database=${profilePath}/Crashpad`,
    ` 414 C:\\Program Files\\Codex\\Codex.exe --database=${profilePath}\\Crashpad`,
    " 412 /Applications/ChatGPT.app/Contents/MacOS/Codex --user-data-dir=/tmp/unrelated",
    ` 413 /bin/zsh -lc echo ${profilePath}-similar`,
    "not-a-process-line",
  ].join("\n");

  assert.deepEqual(ownedIsolationPidsFromProcessList(listing, profilePath, {
    excludedPids: [410],
    root,
  }), [411, 414]);
  assert.throws(() => ownedIsolationPidsFromProcessList(listing, "/tmp/outside", { root }),
    /inside the project/i);

  assert.deepEqual(buildPlatformIsolationProcessListProbe("darwin", profilePath), {
    file: "/bin/ps",
    args: ["ax", "-o", "pid=,command="],
  });
  const windows = buildPlatformIsolationProcessListProbe("win32", profilePath);
  assert.equal(windows.file, "powershell.exe");
  assert.match(windows.args.join(" "), /Win32_Process/);
  assert.match(windows.args.join(" "), /ProcessId/);
  assert.match(windows.args.join(" "), /ProcessId -ne \$PID/);
  assert.throws(() => buildPlatformIsolationProcessListProbe("linux", profilePath),
    /unsupported platform/i);
});

test("native-default cleanup uses the same exact isolated-profile boundary", () => {
  const root = "/project/Codex Dynamic Skin System";
  const profilePath = `${root}/work/isolated-profiles/codex-dream-skin-acceptance.safe`;
  const listing = [
    ` 510 /Applications/ChatGPT.app/Contents/MacOS/Codex --user-data-dir=${profilePath}`,
    ` 511 /Applications/ChatGPT.app/Helpers/crashpad --database=${profilePath}/Crashpad`,
    ` 512 /bin/zsh -lc echo ${profilePath}-similar`,
    " 513 /Applications/ChatGPT.app/Contents/MacOS/Codex --user-data-dir=/tmp/unrelated",
  ].join("\n");

  assert.deepEqual(nativeDefaultCleanupPidsFromProcessList(listing, profilePath, {
    excludedPids: [510],
    root,
  }), [511]);
  assert.throws(() => nativeDefaultCleanupPidsFromProcessList(listing, "/tmp/outside", { root }),
    /inside the project/i);
});

test("builds a bounded native focus sink for background playback evidence", () => {
  const windows = buildPlatformFocusProbe("win32");
  assert.equal(windows.file, "powershell.exe");
  assert.match(windows.args.join(" "), /System\.Windows\.Forms/);
  assert.match(windows.args.join(" "), /ShowInTaskbar/);
  assert.equal(windows.args.join(" ").includes("osascript"), false);

  assert.deepEqual(buildPlatformFocusProbe("darwin"), {
    file: "/usr/bin/osascript",
    args: ["-e", "tell application \"Finder\" to activate"],
    persistent: false,
  });
});

test("normalizes an explicit theme directory or theme.json without changing the source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-theme."));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "theme.json"), "{}\n");

  assert.equal(await normalizeThemeDirectory(root), root);
  assert.equal(await normalizeThemeDirectory(path.join(root, "theme.json")), root);
  await assert.rejects(() => normalizeThemeDirectory(path.join(root, "missing")), /theme/i);
});

test("builds a bounded one-shot injector command for the isolated port and chosen theme", () => {
  assert.deepEqual(buildOneShotInjectorArgs({ port: 19443, themeDir: "/tmp/theme" }), [
    "--once",
    "--port", "19443",
    "--theme-dir", "/tmp/theme",
    "--background-playback-capable",
  ]);
});

test("retries only the verified-shell startup race", () => {
  assert.equal(isRetryableInjectorStartupError(new Error(
    "No verified ChatGPT renderer on 127.0.0.1:19443: No page matched the expected ChatGPT shell markers",
  )), true);
  assert.equal(isRetryableInjectorStartupError(new Error("Theme integrity check failed")), false);
  assert.equal(isRetryableInjectorStartupError(new Error("Expected isolated PID mismatch")), false);
});

test("allows a cold isolated Codex shell to become ready after the observed 30-second boundary", () => {
  assert.equal(ISOLATED_CODEX_STARTUP_TIMEOUT_MS, 90_000);
});

test("creates every isolated profile under the caller-owned project directory", async (t) => {
  const profileRoot = path.resolve(import.meta.dirname, "../..", ".test-isolated-profiles");
  await fs.mkdir(profileRoot, { recursive: true });
  const first = await createIsolation({ profileRoot });
  const second = await createIsolation({ profileRoot });
  t.after(() => Promise.all([
    fs.rm(first.profilePath, { recursive: true, force: true }),
    fs.rm(second.profilePath, { recursive: true, force: true }),
    fs.rm(profileRoot, { recursive: true, force: true }),
  ]));

  assert.notEqual(first.profilePath, second.profilePath);
  assert.notEqual(first.port, second.port);
  assert.equal(path.dirname(first.profilePath), profileRoot);
  assert.equal(path.dirname(second.profilePath), profileRoot);
  assert.equal(first.args.includes(`--user-data-dir=${first.profilePath}`), true);
  assert.equal(first.args.includes(`--remote-debugging-port=${first.port}`), true);
  assert.equal(first.args.includes("--disable-background-media-suspend"), true);
  await assert.rejects(
    () => createIsolation({ profileRoot: path.join(os.tmpdir(), "foreign-isolated-profile") }),
    /inside the project/i,
  );
});

test("accepts only a command line bound to the exact profile, port, and PID", () => {
  const expected = {
    pid: 43210,
    profilePath: "/tmp/codex-isolated.example",
    port: 19443,
  };
  const command = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT " +
    "--user-data-dir=/tmp/codex-isolated.example --remote-debugging-port=19443";
  assert.doesNotThrow(() => assertIsolatedCommand({ ...expected, actualPid: 43210, command }));
  assert.throws(() => assertIsolatedCommand({ ...expected, actualPid: 9, command }), /PID/i);
  assert.throws(() => assertIsolatedCommand({ ...expected, actualPid: 43210, command: command.replace("19443", "19444") }), /port/i);
  assert.throws(() => assertIsolatedCommand({ ...expected, actualPid: 43210, command: command.replace("codex-isolated.example", "primary") }), /profile/i);
});

test("selects the main Codex renderer instead of an auxiliary avatar overlay", () => {
  const targets = [
    {
      id: "avatar",
      type: "page",
      url: "app://-/index.html?initialRoute=%2Favatar-overlay",
      webSocketDebuggerUrl: "ws://avatar",
    },
    {
      id: "main",
      type: "page",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://main",
    },
  ];

  assert.equal(selectCodexRendererTarget(targets)?.id, "main");
  assert.equal(selectCodexRendererTarget(targets.slice(0, 1)), null);
});

test("summarizes stable playback and detects overlap or theme jumping", () => {
  const stable = summarizeRendererSamples([
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, effects: 0, paused: false, loop: true, currentTime: 1.0 },
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, effects: 0, paused: false, loop: true, currentTime: 1.4 },
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, effects: 0, paused: false, loop: true, currentTime: 1.8 },
  ]);
  assert.equal(stable.stable, true);
  assert.equal(stable.playbackAdvanced, true);
  assert.equal(stable.loopEnabled, true);
  assert.equal(stable.videoSamples, 3);
  assert.deepEqual(stable.themeIds, ["mars.space"]);

  const broken = summarizeRendererSamples([
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, effects: 0, paused: false, currentTime: 1 },
    { themeId: "mars.ocean", generation: "g2", roots: 2, videos: 2, effects: 1, paused: false, currentTime: 2 },
  ]);
  assert.equal(broken.stable, false);
  assert.equal(broken.overlapDetected, true);
  assert.equal(broken.themeJumpDetected, true);

  const notLooping = summarizeRendererSamples([
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, paused: false, loop: false, currentTime: 1 },
    { themeId: "mars.space", generation: "g1", roots: 1, videos: 1, paused: false, loop: false, currentTime: 2 },
  ]);
  assert.equal(notLooping.loopEnabled, false);
});

test("redacts profile paths, page content, and account-like fields", () => {
  const profilePath = path.join(os.tmpdir(), "codex-isolated.secret");
  const report = redactAcceptanceReport({
    profilePath,
    command: `ChatGPT --user-data-dir=${profilePath} --remote-debugging-port=19443`,
    target: { url: "app://-/index.html?thread=secret", title: "Private project title" },
    diagnostics: { themeId: "mars.space", conversation: "private", accountEmail: "person@example.com" },
    screenshot: { sha256: "abc", path: `${profilePath}/screen.png` },
  }, { profilePath });

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(profilePath), false);
  assert.equal(serialized.includes("Private project title"), false);
  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("thread=secret"), false);
  assert.equal(report.diagnostics.themeId, "mars.space");
  assert.equal(report.screenshot.sha256, "abc");
});

test("grades enabled background playback and disabled frozen-frame behavior separately", () => {
  const playing = { sampleCount: 20, stable: true, playbackAdvanced: true, pausedSamples: 0, unfocusedSamples: 20 };
  const frozen = { sampleCount: 20, stable: true, playbackAdvanced: false, pausedSamples: 20, unfocusedSamples: 20 };
  const foreground = { sampleCount: 20, stable: true, playbackAdvanced: true, pausedSamples: 0, unfocusedSamples: 0 };
  assert.equal(evaluatePlaybackExpectation(playing, true).pass, true);
  assert.equal(evaluatePlaybackExpectation(frozen, false).pass, true);
  assert.equal(evaluatePlaybackExpectation(frozen, true).pass, false);
  assert.equal(evaluatePlaybackExpectation(playing, false).pass, false);
  assert.equal(evaluatePlaybackExpectation(foreground, true).pass, false,
    "foreground playback is not evidence for background playback");
});

test("accepts semantic UI sounds only when native playback counters advance in one stable generation", () => {
  const summary = summarizeSemanticSoundSamples([
    {
      themeId: "mars.space",
      generation: "g1",
      uiPlayback: {
        byEvent: {
          approvalRequested: { requested: 0, played: 0, rejected: 0 },
          taskFailed: { requested: 0, played: 0, rejected: 0 },
        },
      },
    },
    {
      themeId: "mars.space",
      generation: "g1",
      uiPlayback: {
        byEvent: {
          approvalRequested: { requested: 1, played: 1, rejected: 0 },
          taskFailed: { requested: 1, played: 1, rejected: 0 },
        },
      },
    },
  ], ["approvalRequested", "taskFailed"]);

  assert.equal(summary.stable, true);
  assert.deepEqual(summary.events.approvalRequested, {
    baselinePlayed: 0,
    finalPlayed: 1,
    playedDelta: 1,
    requestedDelta: 1,
    rejectedDelta: 0,
    counterRegressed: false,
  });
  assert.equal(evaluateSemanticSoundExpectation(summary).pass, true);
});

test("rejects requested-only, rejected, stale, reset, or cross-theme semantic sound evidence", () => {
  const requestedOnly = summarizeSemanticSoundSamples([
    { themeId: "mars.space", generation: "g1", uiPlayback: { byEvent: { taskFailed: { requested: 2, played: 4, rejected: 0 } } } },
    { themeId: "mars.space", generation: "g1", uiPlayback: { byEvent: { taskFailed: { requested: 3, played: 4, rejected: 1 } } } },
  ], ["taskFailed"]);
  assert.equal(evaluateSemanticSoundExpectation(requestedOnly).pass, false);

  const reset = summarizeSemanticSoundSamples([
    { themeId: "mars.space", generation: "g1", uiPlayback: { byEvent: { taskFailed: { requested: 3, played: 3, rejected: 0 } } } },
    { themeId: "mars.space", generation: "g1", uiPlayback: { byEvent: { taskFailed: { requested: 0, played: 0, rejected: 0 } } } },
  ], ["taskFailed"]);
  assert.equal(reset.events.taskFailed.counterRegressed, true);
  assert.equal(evaluateSemanticSoundExpectation(reset).pass, false);

  const jumped = summarizeSemanticSoundSamples([
    { themeId: "mars.space", generation: "g1", uiPlayback: { byEvent: { taskFailed: { requested: 0, played: 0, rejected: 0 } } } },
    { themeId: "mars.ocean", generation: "g2", uiPlayback: { byEvent: { taskFailed: { requested: 1, played: 1, rejected: 0 } } } },
  ], ["taskFailed"]);
  assert.equal(jumped.stable, false);
  assert.equal(evaluateSemanticSoundExpectation(jumped).pass, false);
});

test("waits for semantic playback and a bounded stable confirmation window", () => {
  const sample = (played, overrides = {}) => ({
    themeId: "mars.space",
    generation: "g1",
    uiPlayback: {
      byEvent: {
        approvalRequested: { requested: played, played, rejected: 0 },
      },
    },
    ...overrides,
  });
  const readings = [sample(0), sample(1)];

  assert.equal(semanticSoundSamplingComplete(readings, ["approvalRequested"], {
    confirmationSamples: 2,
  }), false, "event playback alone is not enough");

  readings.push(sample(1));
  assert.equal(semanticSoundSamplingComplete(readings, ["approvalRequested"], {
    confirmationSamples: 2,
  }), false, "one stable sample after playback is not enough");

  readings.push(sample(1));
  assert.equal(semanticSoundSamplingComplete(readings, ["approvalRequested"], {
    confirmationSamples: 2,
  }), true);

  readings.push(sample(1, { generation: "g2" }));
  assert.equal(semanticSoundSamplingComplete(readings, ["approvalRequested"], {
    confirmationSamples: 2,
  }), false, "a post-event generation switch invalidates the evidence");
});

test("grades ordinary hot switches without requiring the final-theme voxel contract", () => {
  const audits = [{
    summary: { stable: true, playbackAdvanced: true },
    dynamicRuntimeExpectation: { requireVoxel: false, pass: true },
  }, {
    summary: { stable: true, playbackAdvanced: true },
    dynamicRuntimeExpectation: { requireVoxel: false, pass: true },
  }];
  assert.equal(themeSwitchAuditsPass(audits), true);
  audits[1].summary.stable = false;
  assert.equal(themeSwitchAuditsPass(audits), false);
});
