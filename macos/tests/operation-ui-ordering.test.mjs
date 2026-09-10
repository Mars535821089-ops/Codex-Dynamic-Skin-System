import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/injector.mjs", import.meta.url), "utf8");
// Run the production expression builder and its constants without starting CDP.
const constants = source.slice(source.indexOf("const OPERATION_UI_HOST_ID ="),
  source.indexOf("let operationSequence ="));
const builder = source.slice(source.indexOf("function operationUiExpression("),
  source.indexOf("\nasync function updateOperationUi("));
const operationUiExpression = vm.runInNewContext(`${constants}\n${builder}\noperationUiExpression`, {
  selectorLiteral: () => JSON.stringify('[data-ds-part="shell-main"]'),
});

function createDocument() {
  const createElement = () => ({
    children: [], dataset: {}, style: { setProperty() {} },
    setAttribute() {},
    append(...children) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
    attachShadow() { this.shadowRoot = createElement(); return this.shadowRoot; },
    querySelector(selector) {
      for (const child of this.children) {
        if (selector === `.${child.className}`) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 1000, height: 700 }),
  });
  const documentElement = createElement();
  return {
    documentElement, body: createElement(), createElement,
    querySelector: () => null,
    getElementById: (id) => documentElement.children.find((node) => node.id === id) ?? null,
  };
}

function renderer() {
  let now = 1789044954000;
  let nextTimer = 0;
  const timers = new Map();
  const context = vm.createContext({
    document: createDocument(), innerWidth: 1000, innerHeight: 700,
    getComputedStyle: () => ({ backgroundColor: "rgb(20, 20, 20)" }),
    matchMedia: () => ({ matches: false }),
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  context.window = context;
  return {
    run: (action, token, state = "loading", message = "") =>
      vm.runInContext(operationUiExpression(action, token, state, message), context),
    host: () => context.document.getElementById("chatgpt-dream-skin-operation"),
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
    pendingCallbacks: () => [...timers.values()].map((timer) => timer.callback),
    navigate() { context.document = createDocument(); },
  };
}

const oldToken = "123:1789044954000:1";
const currentToken = "456:1789044955000:1";
const nextToken = "789:1789044956000:1";

test("an old error cannot reappear after the newer success naturally disappears", () => {
  const page = renderer();
  page.run("show", oldToken);
  page.run("show", currentToken, "success", "Applied");
  page.advance(1800);
  assert.equal(page.host(), null);
  const result = page.run("show", oldToken, "error", "Old failure");
  assert.equal(result.stale, true);
  assert.equal(page.host(), null);
});

test("an old hide cannot remove the newer operation", () => {
  const page = renderer();
  page.run("show", oldToken);
  page.run("show", currentToken);
  assert.equal(page.run("hide", oldToken).removed, false);
  page.advance(16);
  assert.equal(page.host().dataset.operationToken, currentToken);
  assert.equal(page.host().dataset.visible, "true");
});

test("a genuinely newer error remains visible after an earlier success expires", () => {
  const page = renderer();
  page.run("show", currentToken, "success", "Applied");
  page.advance(1800);
  assert.equal(page.run("show", nextToken, "error", "New failure").visible, true);
  page.advance(16);
  assert.equal(page.host().dataset.operationToken, nextToken);
  assert.equal(page.host().dataset.state, "error");
  assert.equal(page.host().dataset.visible, "true");
  assert.equal(page.host().shadowRoot.querySelector(".message").textContent, "New failure");
});

test("same-process operations issued in one millisecond preserve sequence ordering", () => {
  const page = renderer();
  page.run("show", "123:1789044954000:2", "success", "Applied");
  page.advance(1800);
  assert.equal(page.run("show", oldToken, "error", "Old failure").stale, true);
  assert.equal(page.host(), null);
});

test("explicit clear removes the UI while retaining stale-event protection in its document", () => {
  const page = renderer();
  page.run("show", currentToken);
  assert.equal(page.run("clear", "").cleared, true);
  page.advance(180000);
  assert.equal(page.host(), null);
  assert.equal(page.run("show", oldToken, "error", "Old failure").stale, true);
  assert.equal(page.host(), null);
  assert.equal(page.run("show", nextToken, "error", "New failure").visible, true);
});

test("a new document does not inherit the previous document operation watermark", () => {
  const page = renderer();
  page.run("show", currentToken, "success", "Applied");
  page.advance(1800);
  page.navigate();
  assert.equal(page.run("show", oldToken, "error", "Current page failure").visible, true);
  page.advance(16);
  assert.equal(page.host().dataset.state, "error");
});

test("queued callbacks from a previous document cannot alter or remove the current UI", () => {
  const page = renderer();
  page.run("show", currentToken);
  const oldCallbacks = page.pendingCallbacks();
  page.navigate();
  page.run("show", currentToken, "error", "Current page failure");
  for (const callback of oldCallbacks) callback();
  assert.ok(page.host());
  assert.equal(page.host().dataset.visible, undefined);
  page.advance(16);
  assert.equal(page.host().dataset.state, "error");
  assert.equal(page.host().dataset.visible, "true");
});
