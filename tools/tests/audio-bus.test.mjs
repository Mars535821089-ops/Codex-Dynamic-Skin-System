import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { FakeDocument, FakeElement, createLedger } from "./helpers/fake-media.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserRoot = path.join(projectRoot, "runtime", "dynamic", "browser");

class FakeNode {
  constructor(kind) { this.kind = kind; this.connections = []; this.gain = { value: 1 }; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeSource extends FakeNode {
  constructor() { super("buffer-source"); this.started = false; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  emitEnded() { this.onended?.(); }
}

class FakeAudioContext {
  static instances = [];
  static mediaElements = new WeakSet();
  constructor() {
    this.state = "suspended";
    this.destination = new FakeNode("destination");
    this.sources = [];
    FakeAudioContext.instances.push(this);
  }
  createGain() { return new FakeNode("gain"); }
  createAnalyser() { const node = new FakeNode("analyser"); node.fftSize = 0; return node; }
  createMediaElementSource(element) {
    if (FakeAudioContext.mediaElements.has(element)) throw new DOMException("already connected", "InvalidStateError");
    FakeAudioContext.mediaElements.add(element);
    const node = new FakeNode("media"); node.element = element; return node;
  }
  createBufferSource() { const node = new FakeSource(); this.sources.push(node); return node; }
  async decodeAudioData(buffer) { if (buffer.byteLength === 13) throw new Error("decode"); return { duration: 0.1 }; }
  async resume() { this.state = "running"; this.resumeCount = (this.resumeCount ?? 0) + 1; }
  async suspend() { this.state = "suspended"; this.suspendCount = (this.suspendCount ?? 0) + 1; }
  async close() { this.state = "closed"; }
}

function makeTheme(source = "visual") {
  return {
    visual: { kind: "video", asset: "media/loop.mp4" },
    audio: {
      ambient: { source, ...(source === "asset" ? { asset: "audio/ambient.m4a" } : {}), loop: true, volume: 0.5, analyze: true },
      ui: { volume: 0.25, events: { taskCompleted: "audio/ui/done.wav" } },
    },
  };
}

const settings = {
  soundEnabled: true, masterVolume: 0.8, ambientVolume: 0.5, uiVolume: 0.4,
  ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
};

async function harness({
  source = "visual",
  fetchBytes = 8,
  fetchImpl,
  assetUrl = "http://local/done",
  now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  FakeAudioContext.instances.length = 0;
  FakeAudioContext.mediaElements = new WeakSet();
  const document = new FakeDocument();
  const visual = new FakeElement("video");
  const mediaLayer = { visualAudioElement: () => visual, setAmbientMuted: (value) => { visual.muted = value; } };
  const context = vm.createContext({
    AbortController, ArrayBuffer, DOMException, Event, EventTarget, Map, Object, Promise, Set,
    clearTimeout: clearTimeoutImpl, setTimeout: setTimeoutImpl, AudioContext: FakeAudioContext,
    fetch: fetchImpl ?? (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(fetchBytes) })),
  });
  context.window = context;
  context.document = document;
  vm.runInContext(await fs.readFile(path.join(browserRoot, "module-registry.js"), "utf8"), context);
  vm.runInContext(await fs.readFile(path.join(browserRoot, "audio-bus.js"), "utf8"), context);
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("audio-bus")({ document, window: context });
  const bus = service.create({
    config: {
      theme: makeTheme(source), settings,
      assets: { "audio/ambient.m4a": "http://local/ambient", "audio/ui/done.wav": assetUrl },
    },
    modules: new Map([["media-layer", mediaLayer]]), ledger: createLedger(), now,
  });
  return { bus, document, visual };
}

test("audio stays absent before a trusted gesture and visual audio uses independent gains", async () => {
  const { bus, visual } = await harness();
  await bus.prepare();
  assert.equal(FakeAudioContext.instances.length, 0);
  assert.equal(visual.muted, true);
  await assert.rejects(bus.unlockFromGesture({ isTrusted: false }), (error) => error?.code === "GESTURE_REQUIRED");
  await bus.unlockFromGesture({ isTrusted: true });
  const diagnostic = bus.diagnostics();
  assert.equal(diagnostic.unlocked, true);
  assert.equal(diagnostic.gains.master, 0.8);
  assert.equal(diagnostic.gains.ambient, 0.25);
  assert.equal(diagnostic.gains.ui, 0.1);
  assert.equal(visual.muted, false);
  assert.ok(bus.analyser());
  bus.setSettings({ ...settings, ambientMuted: true });
  assert.equal(bus.diagnostics().gains.ambient, 0);
  assert.equal(bus.diagnostics().gains.ui, 0.1);
  await bus.destroy();
  assert.equal(visual.muted, true);
  assert.equal(FakeAudioContext.instances[0].state, "closed");
});

test("separate ambient uses its own media element and obeys hidden-page policy", async () => {
  const { bus, document, visual } = await harness({ source: "asset" });
  await bus.prepare();
  const ambient = document.created.find((element) => element.tagName === "AUDIO");
  assert.equal(ambient.src, "http://local/ambient");
  assert.equal(ambient.crossOrigin, "anonymous");
  await bus.unlockFromGesture({ isTrusted: true });
  assert.equal(ambient.playCount, 1);
  assert.equal(visual.muted, true);
  document.setHidden(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeAudioContext.instances[0].state, "suspended");
  document.setHidden(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeAudioContext.instances[0].state, "running");
  await bus.destroy();
});

test("changing hidden audio to continue resumes an already suspended context", async () => {
  const { bus, document } = await harness({ source: "asset" });
  await bus.prepare();
  await bus.unlockFromGesture({ isTrusted: true });
  document.setHidden(true);
  await new Promise((resolve) => setImmediate(resolve));
  const context = FakeAudioContext.instances[0];
  assert.equal(context.state, "suspended");
  const resumesBefore = context.resumeCount;
  bus.setSettings({ hiddenAudio: "continue" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "running");
  assert.equal(context.resumeCount, resumesBefore + 1);
  await bus.destroy();
});

test("UI clips require unlock, cool down per event, and cap overlap at four", async () => {
  let clock = 1000;
  const { bus } = await harness({ source: "none", now: () => clock });
  assert.equal(await bus.playUi("taskCompleted"), false);
  await bus.unlockFromGesture({ isTrusted: true });
  assert.equal(await bus.playUi("taskCompleted"), true);
  assert.equal(await bus.playUi("taskCompleted"), false);
  for (let index = 0; index < 4; index += 1) {
    clock += 500;
    await bus.playUi("taskCompleted");
  }
  assert.equal(FakeAudioContext.instances[0].sources.filter((source) => source.started).length, 4);
  const diagnostic = bus.diagnostics();
  assert.equal(diagnostic.uiVoices, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.uiPlayback)), {
    requested: 7,
    played: 4,
    rejected: 3,
    byEvent: { taskCompleted: { requested: 7, played: 4, rejected: 3 } },
  });
  await bus.destroy();
  assert.ok(FakeAudioContext.instances[0].sources.every((source) => source.stopped));
});

test("UI decode failure degrades that clip without disabling ambient audio", async () => {
  const { bus } = await harness({ source: "none", fetchBytes: 13 });
  await bus.unlockFromGesture({ isTrusted: true });
  assert.equal(bus.diagnostics().status, "active");
  assert.equal(bus.diagnostics().uiStatus, "degraded");
  assert.equal(await bus.playUi("taskCompleted"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(bus.diagnostics().uiPlayback.byEvent.taskCompleted)),
    { requested: 1, played: 0, rejected: 1 });
  await bus.destroy();
});

test("renderer blob UI clips use media playback without fetching the opaque blob URL", async () => {
  const calls = [];
  const { bus, document } = await harness({ source: "none", assetUrl: "blob:app://-/clip", fetchImpl: async (...args) => {
    calls.push(args);
    throw new TypeError("Failed to fetch");
  } });
  await bus.unlockFromGesture({ isTrusted: true });
  assert.deepEqual(calls, []);
  assert.equal(await bus.playUi("taskCompleted"), true);
  const uiVoice = document.created.find((element) => element.tagName === "AUDIO");
  assert.equal(uiVoice.src, "blob:app://-/clip");
  assert.equal(uiVoice.playCount, 1);
  await bus.destroy();
});

test("a transient UI clip fetch failure cannot poison or rebind visual audio", async () => {
  let attempts = 0;
  const { bus } = await harness({ fetchImpl: async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("Failed to fetch");
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  } });
  await bus.unlockFromGesture({ isTrusted: true });
  assert.equal(bus.diagnostics().status, "active");
  assert.equal(bus.diagnostics().unlocked, true);
  assert.equal(bus.diagnostics().uiStatus, "degraded");
  assert.equal(FakeAudioContext.instances.length, 1);
  await bus.destroy();
});

test("a UI clip endpoint that never responds cannot leave audio unlock pending", async () => {
  let receivedSignal = null;
  const { bus } = await harness({
    setTimeoutImpl(callback) { queueMicrotask(callback); return 1; },
    clearTimeoutImpl() {},
    fetchImpl: async (_url, options) => {
      receivedSignal = options?.signal ?? null;
      return await new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")),
          { once: true });
      });
    },
  });

  await Promise.race([
    bus.unlockFromGesture({ isTrusted: true }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("audio unlock remained pending")), 250)),
  ]);

  assert.equal(receivedSignal?.aborted, true);
  assert.equal(bus.diagnostics().status, "active");
  assert.equal(bus.diagnostics().uiStatus, "degraded");
  await bus.destroy();
});
