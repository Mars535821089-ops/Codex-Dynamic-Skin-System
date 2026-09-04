import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserRoot = path.join(projectRoot, "runtime", "dynamic", "browser");

async function moduleFactory(name, globals = {}) {
  const context = vm.createContext({
    Float32Array, Uint8Array, Math, Map, Object, Set, Promise, Event, EventTarget,
    ...globals,
  });
  context.window = context;
  vm.runInContext(await fs.readFile(path.join(browserRoot, "module-registry.js"), "utf8"), context);
  vm.runInContext(await fs.readFile(path.join(browserRoot, `${name}.js`), "utf8"), context);
  return { context, factory: context.__CODEX_DYNAMIC_SKIN_MODULES__.get(name) };
}

test("signal model reuses bounded arrays and reacts to analyser energy", async () => {
  const analyser = {
    frequencyBinCount: 64,
    fftSize: 128,
    getByteFrequencyData(target) { target.fill(0); target[8] = 255; target[24] = 160; },
  };
  const { context, factory } = await moduleFactory("signal-model");
  const service = factory({ window: context, document: { hidden: false } });
  const signal = service.create({
    config: { theme: { effect: { source: "ambient", parameters: { smoothing: 0.5 } } } },
    modules: new Map([
      ["audio-bus", { analyser: () => analyser }],
      ["performance-policy", { tier: () => "full" }],
    ]),
  });
  const first = signal.sample(1000);
  const second = signal.sample(1016);
  assert.equal(first, second, "the per-frame band vector must be preallocated");
  assert.equal(first.length, 32);
  assert.ok(first.some((value) => value > 0));
  assert.equal(analyser.fftSize, 1024);
  assert.equal(signal.diagnostics().source, "ambient");
  await signal.destroy();
});

test("signal model stays deterministic and alive without ambient audio", async () => {
  const { context, factory } = await moduleFactory("signal-model");
  const signal = factory({ window: context, document: { hidden: false } }).create({
    config: { theme: { effect: { source: "none", parameters: { smoothing: 0.7 } } } },
    modules: new Map([["performance-policy", { tier: () => "balanced" }]]),
  });
  const a = Array.from(signal.sample(2000));
  const b = Array.from(signal.sample(2000));
  assert.deepEqual(a, b);
  assert.ok(a.some((value) => value > 0));
  assert.equal(signal.diagnostics().source, "procedural");
});

test("performance policy downgrades sticky tiers after sustained slow frames", async () => {
  const applied = [];
  const { context, factory } = await moduleFactory("performance-policy", {
    matchMedia: () => ({ matches: false }),
    WebGL2RenderingContext: function WebGL2RenderingContext() {},
  });
  const policy = factory({ window: context, document: { hidden: false } }).create({
    config: { settings: { quality: "auto", reducedMotion: "off" }, theme: { visual: { kind: "builtin-effect" } } },
    modules: new Map([["media-layer", { setTier: (tier) => applied.push(tier) }]]),
  });
  assert.equal(policy.tier(), "full");
  for (let elapsed = 0; elapsed < 5100; elapsed += 100) policy.observeFrame(30, 100);
  assert.equal(policy.tier(), "balanced");
  for (let elapsed = 0; elapsed < 5100; elapsed += 100) policy.observeFrame(45, 100);
  assert.equal(policy.tier(), "media");
  policy.observeFrame(1, 10000);
  assert.equal(policy.tier(), "media", "a session downgrade must not oscillate upward");
  assert.deepEqual(applied.slice(-2), ["balanced", "media"]);
  assert.equal(policy.setPreference("full", "off"), "full",
    "an explicit saved preference may recover from an automatic downgrade");
  assert.equal(policy.tier(), "full");
  assert.equal(policy.setPreference("auto", "on"), "static");
});

function fakeGl() {
  const calls = [];
  const gl = new Proxy({
    calls,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8, COLOR_BUFFER_BIT: 9,
    DEPTH_BUFFER_BIT: 10, DEPTH_TEST: 11, BLEND: 12, SRC_ALPHA: 13,
    ONE_MINUS_SRC_ALPHA: 14,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createVertexArray: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    getUniformLocation: (_program, name) => name,
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
  });
  return gl;
}

test("voxel field uses WebGL2 instancing, responds to context loss, and releases resources", async () => {
  const gl = fakeGl();
  let rafCallback = null;
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = (kind) => kind === "webgl2" ? gl : null;
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  const mediaTiers = [];
  const signal = new Float32Array(32).fill(0.5);
  const { context, factory } = await moduleFactory("voxel-field", {
    devicePixelRatio: 2,
    requestAnimationFrame(callback) { rafCallback = callback; return 7; },
    cancelAnimationFrame() { rafCallback = null; },
    addEventListener() {}, removeEventListener() {},
  });
  const effect = factory({ window: context, document: { hidden: false } }).create({
    config: { generation: "voxel-test", theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier: (tier) => mediaTiers.push(tier) }],
      ["signal-model", { sample: () => signal }],
      ["performance-policy", { tier: () => "full", observeFrame() {} }],
    ]),
    ledger: { track() {} },
  });
  await effect.prepare(); await effect.ready(); await effect.commit();
  rafCallback?.(16);
  assert.ok(gl.calls.some(([name]) => name === "drawArraysInstanced"));
  const lost = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true);
  assert.equal(effect.diagnostics().phase, "fallback");
  assert.equal(mediaTiers.at(-1), "media");
  await effect.destroy();
  assert.ok(gl.calls.some(([name]) => name === "deleteProgram"));
});

test("reduced motion keeps voxel field static without allocating a WebGL context", async () => {
  let contextRequests = 0;
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.getContext = () => { contextRequests += 1; return fakeGl(); };
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  const { context, factory } = await moduleFactory("voxel-field", {
    requestAnimationFrame() { throw new Error("static mode must not schedule frames"); },
    cancelAnimationFrame() {},
  });
  const effect = factory({ window: context, document: { hidden: false } }).create({
    config: { theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier() {} }],
      ["signal-model", { sample: () => new Float32Array(32) }],
      ["performance-policy", { tier: () => "static", observeFrame: () => "static" }],
    ]),
    ledger: { track() {} },
  });
  await effect.prepare();
  assert.equal(await effect.commit(), false);
  assert.equal(contextRequests, 0);
  assert.equal(effect.diagnostics().renderer, "static");
  await effect.destroy();
});

test("voxel field resumes animation when a hidden document becomes visible again", async () => {
  const gl = fakeGl();
  let rafCallback = null;
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = () => gl;
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  const document = new EventTarget();
  document.hidden = false;
  const { context, factory } = await moduleFactory("voxel-field", {
    requestAnimationFrame(callback) { rafCallback = callback; return 9; },
    cancelAnimationFrame() { rafCallback = null; },
    devicePixelRatio: 1,
  });
  const effect = factory({ window: context, document }).create({
    config: { theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier() {} }],
      ["signal-model", { sample: () => new Float32Array(32) }],
      ["performance-policy", { tier: () => "full", observeFrame: () => "full" }],
    ]),
    ledger: { track() {} },
  });
  await effect.prepare();
  await effect.commit();
  const runFrame = (time) => { const callback = rafCallback; rafCallback = null; callback?.(time); };
  runFrame(16);
  const beforeHidden = effect.diagnostics().frames;
  document.hidden = true;
  runFrame(32);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  runFrame(48);
  assert.equal(effect.diagnostics().frames, beforeHidden + 1);
  await effect.destroy();
});

test("voxel field can recover from an initial static tier after motion is enabled", async () => {
  const gl = fakeGl();
  let tier = "static";
  let rafCallback = null;
  let contextRequests = 0;
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = () => { contextRequests += 1; return gl; };
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  const { context, factory } = await moduleFactory("voxel-field", {
    requestAnimationFrame(callback) { rafCallback = callback; return 10; },
    cancelAnimationFrame() { rafCallback = null; },
    devicePixelRatio: 1,
  });
  const effect = factory({ window: context, document: { hidden: false } }).create({
    config: { theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier() {} }],
      ["signal-model", { sample: () => new Float32Array(32) }],
      ["performance-policy", { tier: () => tier, observeFrame: () => tier }],
    ]),
    ledger: { track() {} },
  });
  await effect.prepare();
  assert.equal(await effect.commit(), false);
  assert.equal(contextRequests, 0);
  tier = "full";
  assert.equal(effect.setTier("full"), true);
  const callback = rafCallback;
  rafCallback = null;
  callback?.(16);
  assert.equal(contextRequests, 1);
  assert.equal(effect.diagnostics().phase, "active");
  assert.equal(effect.diagnostics().frames, 1);
  await effect.destroy();
});

test("voxel field does not strand its animation when preferences arrive before prepare", async () => {
  const gl = fakeGl();
  let rafCallback = null;
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = () => gl;
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  const { context, factory } = await moduleFactory("voxel-field", {
    requestAnimationFrame(callback) { rafCallback = callback; return 11; },
    cancelAnimationFrame() { rafCallback = null; },
    devicePixelRatio: 1,
  });
  const effect = factory({ window: context, document: { hidden: false } }).create({
    config: { theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier() {} }],
      ["signal-model", { sample: () => new Float32Array(32) }],
      ["performance-policy", { tier: () => "full", observeFrame: () => "full" }],
    ]),
    ledger: { track() {} },
  });

  effect.setTier("full");
  const prematureFrame = rafCallback;
  await effect.prepare();
  rafCallback = null;
  prematureFrame?.(16);
  await effect.commit();

  assert.equal(typeof rafCallback, "function",
    "commit must schedule a live frame after a pre-prepare preference update");
  rafCallback?.(32);
  assert.equal(effect.diagnostics().frames, 1);
  await effect.destroy();
});

test("WebGL context loss makes the session performance fallback sticky", async () => {
  const gl = fakeGl();
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.getContext = () => gl;
  canvas.getBoundingClientRect = () => ({ width: 640, height: 480 });
  const fallbacks = [];
  const { context, factory } = await moduleFactory("voxel-field", {
    requestAnimationFrame() { return 4; }, cancelAnimationFrame() {}, devicePixelRatio: 1,
  });
  const effect = factory({ window: context, document: { hidden: false } }).create({
    config: { theme: { effect: { parameters: {
      gridSize: 16, height: 2, bloom: 0.3, smoothing: 0.7,
      palette: ["#8b5cf6", "#22d3ee", "#f472b6"],
    } } } },
    modules: new Map([
      ["media-layer", { effectCanvas: () => canvas, setTier() {} }],
      ["signal-model", { sample: () => new Float32Array(32) }],
      ["performance-policy", {
        tier: () => fallbacks.length ? "media" : "full",
        observeFrame: () => "full",
        forceFallback: (reason) => { fallbacks.push(reason); return { tier: "media", reason }; },
      }],
    ]),
    ledger: { track() {} },
  });
  await effect.prepare();
  await effect.commit();
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  assert.deepEqual(fallbacks, ["webgl-context-lost"]);
  assert.equal(effect.diagnostics().tier, "media");
  await effect.destroy();
});

test("semantic events are allowlisted, debounced, and do not read message text", async () => {
  const played = [];
  const document = {
    hidden: false,
    documentElement: {},
    querySelectorAll() { return []; },
  };
  const target = new EventTarget();
  const { context, factory } = await moduleFactory("semantic-events", {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: { taskCompleted: "done.wav", taskFailed: "fail.wav" } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  assert.equal(semantic.ingest("completed", "task-1", 1000), true);
  assert.equal(semantic.ingest("completed", "task-1", 1200), false);
  assert.equal(semantic.ingest("approval", "task-1", 2000), false);
  assert.equal(semantic.ingest("failed", "task-1", 2100), true);
  assert.deepEqual(played, ["taskCompleted", "taskFailed"]);
  assert.equal(semantic.diagnostics().emitted, 2);
  await semantic.destroy();
});

test("semantic DOM inspection ignores generic component states without task identity", async () => {
  const played = [];
  const element = (attributes) => ({
    id: attributes.id ?? "",
    getAttribute(name) { return attributes[name] ?? null; },
    querySelectorAll() { return []; },
  });
  const nodes = [
    element({ "data-state": "error" }),
    element({ "data-status": "failed", "data-task-id": "task-2" }),
    element({ "data-task-state": "completed", id: "task-3" }),
    element({ "data-testid": "approval-request-card", id: "approval-4" }),
    element({ "data-codex-approval-surface": "", id: "approval-native-5" }),
  ];
  const document = {
    hidden: false,
    documentElement: element({}),
    querySelectorAll() { return nodes; },
  };
  const { context, factory } = await moduleFactory("semantic-events");
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: {
      taskCompleted: "done.wav",
      taskFailed: "fail.wav",
      approvalRequested: "approval.wav",
    } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  assert.deepEqual(played, ["taskFailed", "taskCompleted", "approvalRequested", "approvalRequested"]);
  assert.equal(semantic.diagnostics().emitted, 4);
  await semantic.destroy();
});

test("semantic events emit once for a newly completed native assistant boundary and ignore history", async () => {
  const played = [];
  let observeCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const finalNode = () => ({
    id: "",
    getAttribute(name) {
      if (name === "data-local-conversation-final-assistant") return "";
      return null;
    },
    querySelectorAll() { return []; },
  });
  const existing = finalNode();
  const root = {
    getAttribute() { return null; },
    querySelectorAll(selector) {
      return selector.includes("data-local-conversation-final-assistant") ? [existing] : [];
    },
  };
  const document = {
    hidden: false,
    documentElement: root,
    querySelectorAll: root.querySelectorAll.bind(root),
  };
  const { context, factory } = await moduleFactory("semantic-events", {
    MutationObserver: FakeMutationObserver,
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: { taskCompleted: "done.wav" } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  assert.deepEqual(played, [], "existing conversation history must be baselined silently");

  const completed = finalNode();
  observeCallback?.([{ type: "childList", addedNodes: [completed] }]);
  observeCallback?.([{ type: "childList", addedNodes: [completed] }]);
  assert.deepEqual(played, ["taskCompleted"]);
  assert.equal(semantic.diagnostics().nativeFinalBoundaries, 1);
  await semantic.destroy();
});

test("semantic events classify a native assistant boundary with a failed command as task failed", async () => {
  const played = [];
  let observeCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const root = {
    getAttribute() { return null; },
    querySelectorAll() { return []; },
  };
  const document = {
    hidden: false,
    documentElement: root,
    querySelectorAll: root.querySelectorAll.bind(root),
  };
  const { context, factory } = await moduleFactory("semantic-events", {
    MutationObserver: FakeMutationObserver,
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: {
      taskCompleted: "done.wav",
      taskFailed: "fail.wav",
    } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  const failed = {
    id: "",
    getAttribute(name) {
      if (name === "data-local-conversation-final-assistant") return "";
      return null;
    },
    querySelectorAll() { return []; },
    __reactFiber$test: {
      memoizedProps: {
        mcpTurn: { status: "completed", error: null, items: [{ type: "commandExecution", status: "failed" }] },
      },
      return: null,
    },
  };
  observeCallback?.([{ type: "childList", addedNodes: [failed] }]);
  assert.deepEqual(played, ["taskFailed"]);
  assert.equal(semantic.diagnostics().nativeFinalBoundaries, 1);
  await semantic.destroy();
});

test("semantic events classify a native failed hook run as task failed", async () => {
  const played = [];
  let observeCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const root = {
    getAttribute() { return null; },
    querySelectorAll() { return []; },
  };
  const document = {
    hidden: false,
    documentElement: root,
    querySelectorAll: root.querySelectorAll.bind(root),
  };
  const { context, factory } = await moduleFactory("semantic-events", {
    MutationObserver: FakeMutationObserver,
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: {
      taskCompleted: "done.wav",
      taskFailed: "fail.wav",
    } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  const failed = {
    id: "",
    getAttribute(name) {
      if (name === "data-local-conversation-final-assistant") return "";
      return null;
    },
    querySelectorAll() { return []; },
    __reactFiber$test: {
      memoizedProps: {
        mcpTurn: {
          status: "completed",
          error: null,
          items: [{ type: "agentMessage", phase: "final_answer" }],
          hookRuns: [{ run: { handlerType: "command", status: "failed", entries: [{ kind: "error" }] } }],
        },
      },
      return: null,
    },
  };
  observeCallback?.([{ type: "childList", addedNodes: [failed] }]);
  assert.deepEqual(played, ["taskFailed"]);
  assert.equal(semantic.diagnostics().nativeFinalBoundaries, 1);
  await semantic.destroy();
});

test("semantic events do not complete an in-progress native turn before its failed command settles", async () => {
  const played = [];
  const timers = new Map();
  let nextTimer = 0;
  let observeCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const root = {
    getAttribute() { return null; },
    querySelectorAll() { return []; },
  };
  const document = {
    hidden: false,
    documentElement: root,
    querySelectorAll: root.querySelectorAll.bind(root),
  };
  const { context, factory } = await moduleFactory("semantic-events", {
    MutationObserver: FakeMutationObserver,
    setTimeout(callback) { nextTimer += 1; timers.set(nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: {
      taskCompleted: "done.wav",
      taskFailed: "fail.wav",
    } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  const turn = { status: "inProgress", error: null, items: [] };
  const node = {
    id: "",
    isConnected: true,
    getAttribute(name) {
      if (name === "data-local-conversation-final-assistant") return "";
      return null;
    },
    querySelectorAll() { return []; },
    __reactFiber$test: { memoizedProps: { mcpTurn: turn }, return: null },
  };
  observeCallback?.([{ type: "childList", addedNodes: [node] }]);
  assert.deepEqual(played, [], "an in-progress boundary is provisional, not completed");
  assert.equal(timers.size, 1, "the provisional boundary must be checked again");

  turn.items.push({ type: "commandExecution", status: "failed" });
  const retry = timers.values().next().value;
  timers.clear();
  retry?.();
  assert.deepEqual(played, ["taskFailed"]);
  assert.equal(timers.size, 0);
  await semantic.destroy();
});

test("semantic events follow a replaced native boundary until its failed hook settles", async () => {
  const played = [];
  const timers = new Map();
  let nextTimer = 0;
  let observeCallback = null;
  let currentFinal = null;
  class FakeMutationObserver {
    constructor(callback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const root = {
    getAttribute() { return null; },
    querySelectorAll(selector) {
      return selector.includes("data-local-conversation-final-assistant") && currentFinal ? [currentFinal] : [];
    },
  };
  const document = {
    hidden: false,
    documentElement: root,
    querySelectorAll: root.querySelectorAll.bind(root),
  };
  const { context, factory } = await moduleFactory("semantic-events", {
    MutationObserver: FakeMutationObserver,
    setTimeout(callback) { nextTimer += 1; timers.set(nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const semantic = factory({ window: context, document }).create({
    config: { theme: { audio: { ui: { events: {
      taskCompleted: "done.wav",
      taskFailed: "fail.wav",
    } } } } },
    modules: new Map([["audio-bus", { playUi: (name) => played.push(name) }]]),
    ledger: { track() {} },
  });
  const pendingTurn = { status: "inProgress", error: null, items: [] };
  const pending = {
    id: "",
    isConnected: true,
    getAttribute(name) {
      if (name === "data-local-conversation-final-assistant") return "";
      return null;
    },
    querySelectorAll() { return []; },
    __reactFiber$test: { memoizedProps: { mcpTurn: pendingTurn }, return: null },
  };
  currentFinal = pending;
  observeCallback?.([{ type: "childList", addedNodes: [pending] }]);
  assert.equal(timers.size, 1);

  pending.isConnected = false;
  currentFinal = {
    ...pending,
    isConnected: true,
    __reactFiber$test: {
      memoizedProps: {
        mcpTurn: {
          status: "inProgress",
          error: null,
          items: [{ type: "agentMessage", phase: "final_answer" }],
          hookRuns: [{ run: { handlerType: "command", status: "failed", entries: [{ kind: "error" }] } }],
        },
      },
      return: null,
    },
  };
  const retry = timers.values().next().value;
  timers.clear();
  retry?.();
  assert.deepEqual(played, ["taskFailed"]);
  assert.equal(timers.size, 0);
  await semantic.destroy();
});
