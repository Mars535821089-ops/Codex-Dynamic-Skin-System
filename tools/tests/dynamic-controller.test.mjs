import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserRoot = path.join(projectRoot, "runtime", "dynamic", "browser");

async function loadController(modules) {
  const context = vm.createContext({
    AbortController,
    AggregateError,
    DOMException,
    Map,
    Object,
    Promise,
    Set,
  });
  context.window = context;
  context.document = { hidden: false };
  vm.runInContext(await fs.readFile(path.join(browserRoot, "module-registry.js"), "utf8"), context);
  vm.runInContext(await fs.readFile(path.join(browserRoot, "controller.js"), "utf8"), context);
  const factory = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controller");
  return factory({
    config: { generation: "bootstrap" },
    modules,
    document: context.document,
    window: context,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeMediaFactory(events, gates = new Map()) {
  return {
    create({ config, ledger }) {
      const id = config.generation;
      ledger.track("media", () => events.push(`ledger:${id}`));
      return {
        async ready() {
          events.push(`ready:${id}`);
          const gate = gates.get(id);
          if (gate) await gate.promise;
          if (config.fail) throw new Error(`decode:${id}`);
        },
        async commit() { events.push(`commit:${id}`); },
        reveal() { events.push(`reveal:${id}`); },
        conceal() { events.push(`conceal:${id}`); },
        async destroy() { events.push(`destroy:${id}`); },
        diagnostics() { return { ready: true, id }; },
      };
    },
  };
}

test("controller stages before commit and preserves the last known-good generation", async () => {
  const events = [];
  const controller = await loadController(new Map([
    ["media-layer", fakeMediaFactory(events)],
  ]));
  const first = await controller.stage({ generation: "A", theme: {}, assets: {}, settings: {} });
  assert.equal(first.phase, "active");
  assert.deepEqual(events, ["ready:A", "commit:A"]);
  await controller.activate();
  assert.deepEqual(events, ["ready:A", "commit:A", "reveal:A"]);

  await assert.rejects(
    controller.stage({ generation: "B", theme: {}, assets: {}, settings: {}, fail: true }),
    /decode:B/,
  );
  assert.equal(controller.diagnostics().generation, "A");
  assert.deepEqual(events.slice(-3), ["ready:B", "destroy:B", "ledger:B"]);

  await controller.destroy();
  await controller.destroy();
  assert.deepEqual(events.slice(-2), ["destroy:A", "ledger:A"]);
  assert.equal(controller.diagnostics().phase, "idle");
});

test("controller keeps a staged generation concealed until the atomic handoff", async () => {
  const events = [];
  const controller = await loadController(new Map([
    ["media-layer", fakeMediaFactory(events)],
  ]));

  await controller.stage({ generation: "incoming", theme: {}, assets: {}, settings: {} });
  assert.deepEqual(events, ["ready:incoming", "commit:incoming"],
    "preloaded media must not become visible during staging");
  await controller.activate();
  assert.deepEqual(events, ["ready:incoming", "commit:incoming", "reveal:incoming"]);
  await controller.conceal();
  assert.deepEqual(events, ["ready:incoming", "commit:incoming", "reveal:incoming", "conceal:incoming"]);
  await controller.destroy();
});

test("controller treats an already-active generation as an idempotent no-op", async () => {
  const events = [];
  const controller = await loadController(new Map([
    ["media-layer", fakeMediaFactory(events)],
  ]));
  await controller.stage({ generation: "stable", theme: {}, assets: {}, settings: {} });
  const repeated = await controller.stage({ generation: "stable", theme: {}, assets: {}, settings: {} });
  assert.equal(repeated.generation, "stable");
  assert.deepEqual(events, ["ready:stable", "commit:stable"],
    "an identical hot payload must not restart its video or create a second visual layer");
  await controller.destroy();
});

test("controller supersedes stale A to B to A work and cleans every resource", async () => {
  const events = [];
  const gates = new Map([["A1", deferred()], ["B", deferred()]]);
  const controller = await loadController(new Map([
    ["media-layer", fakeMediaFactory(events, gates)],
  ]));
  const a1 = controller.stage({ generation: "A1", theme: {}, assets: {}, settings: {} });
  const b = controller.stage({ generation: "B", theme: {}, assets: {}, settings: {} });
  const a2 = controller.stage({ generation: "A2", theme: {}, assets: {}, settings: {} });
  gates.get("A1").resolve();
  gates.get("B").resolve();
  await assert.rejects(a1, (error) => error?.code === "SUPERSEDED");
  await assert.rejects(b, (error) => error?.code === "SUPERSEDED");
  assert.equal((await a2).generation, "A2");
  assert.equal(controller.diagnostics().resources.media, 1);
  await controller.destroy();
  assert.equal(events.filter((value) => value.startsWith("destroy:")).length, 3);
  assert.equal(events.filter((value) => value.startsWith("ledger:")).length, 3);
  assert.equal(JSON.stringify(controller.diagnostics().resources), "{}");
});

test("resource cleanup is LIFO, idempotent, and continues after disposer failures", async () => {
  const order = [];
  const controller = await loadController(new Map([["media-layer", {
    create({ ledger }) {
      ledger.track("listener", () => order.push("first"));
      ledger.track("timer", () => { order.push("second"); throw new Error("cleanup fault"); });
      return {
        async ready() {}, async commit() {},
        async destroy() { order.push("module"); },
      };
    },
  }]]));
  await controller.stage({ generation: "cleanup", theme: {}, assets: {}, settings: {} });
  await assert.rejects(controller.destroy(), /cleanup fault/);
  assert.deepEqual(order, ["module", "second", "first"]);
  assert.equal(controller.diagnostics().phase, "idle");
  assert.equal(await controller.destroy(), false);
});
