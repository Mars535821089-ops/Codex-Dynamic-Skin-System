import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as injector from "../scripts/injector.mjs";
import { isTransientThemeStorageError } from "../scripts/theme-storage-actions.mjs";

const source = await fs.readFile(new URL("../scripts/injector.mjs", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing verifier boundary: ${start}`);
  return source.slice(first, last);
}
const oneShot = section("async function runOneShot(options)", "export async function waitForEarlyGenerationApplied(");
const waitLoaded = section("async function waitForLoadedSession(", "export function isLoadedThemeOwnershipHealthy(");

async function writeTheme(directory, id) {
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(new URL("../../tools/tests/fixtures/media/tiny.webp", import.meta.url), path.join(directory, "background.webp"));
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({
    schemaVersion: 2, id, name: id, version: "1.0.0", capabilities: [],
    visual: { kind: "image", asset: "background.webp", fit: "cover", opacity: 1 },
    audio: { ambient: { source: "none", loop: true, volume: 0, analyze: false }, ui: { volume: 0, events: {} } },
    tokens: {},
  }));
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-verifier-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const themeDir = path.join(root, "local-fallback");
  const library = path.join(root, "External Disk", "themes");
  await writeTheme(themeDir, "test.local");
  await writeTheme(path.join(library, "selected"), "test.external");
  await fs.mkdir(path.join(root, "themes"));
  const preference = path.join(root, "theme-storage.json");
  await fs.writeFile(preference, JSON.stringify({ schemaVersion: 1, libraryRoot: library }));
  const options = { mode: "verify", port: 0, timeoutMs: 100, displayMode: "native",
    themeDir, themeLibrary: path.join(root, "themes"), settings: path.join(root, "dynamic-settings.json") };
  const baseline = await injector.loadPayloadForOptions(options);
  // Exercise the real native renderer verification expression and its exact
  // revision check, without CDP, a browser, shell orchestration, or a live app.
  const context = vm.createContext({
    window: { __CODEX_DYNAMIC_SKIN_NATIVE_STATE__: {
      generation: baseline.revision, displayMode: "native", activation: "active", modules: ["controller", "controls"],
    } },
    document: {
      documentElement: { attributes: [], style: [] },
      querySelectorAll: (selector) => selector === "[data-dynamic-skin-controls]" ? [{}] : [],
      querySelector: () => null,
      getElementById: () => null,
    },
  });
  const metrics = { calls: [], evaluations: 0, closes: 0, output: [], process: { exitCode: 0 } };
  const session = {
    evaluate: async (expression) => { metrics.evaluations++; return vm.runInContext(expression, context); },
    close: () => { metrics.closes++; },
  };
  const dependencies = {
    ...injector, isTransientThemeStorageError, SKIN_VERSION: "fixture",
    connectCodexTargets: async () => [{ target: { id: "fixture" }, session }],
    loadPayloadForOptions: async (received) => { metrics.calls.push(received); return injector.loadPayloadForOptions(received); },
    process: metrics.process, console: { log: (value) => metrics.output.push(JSON.parse(value)) },
    presentOperationUi: async () => {},
  };
  const run = new Function(...Object.keys(dependencies), `${waitLoaded}\n${oneShot}\nreturn runOneShot;`)(...Object.values(dependencies));
  return { root, external: await fs.realpath(library), preference, options, metrics, run };
}

function denyFinalScan(t, f, shouldDeny, error = Object.assign(new Error("fixture late scandir denial"), { code: "EPERM" })) {
  const original = fs.readdir;
  let reads = 0;
  t.mock.method(fs, "readdir", async (directory, ...args) => {
    if (path.resolve(String(directory)) === f.external && shouldDeny(++reads)) throw error;
    return original.call(fs, directory, ...args);
  });
  return error;
}

test("hot verifier retries one late scan EPERM with the original complete options", async (t) => {
  const f = await fixture(t);
  denyFinalScan(t, f, (read) => read === 4);
  await f.run(f.options);
  assert.equal(f.metrics.calls.length, 2);
  assert.ok(f.metrics.calls.every((options) => options === f.options));
  assert.equal(f.metrics.process.exitCode, 0);
  assert.equal(f.metrics.output[0].targets[0].result.pass, true);
  assert.equal(f.metrics.output[0].targets[0].result.revisionMatches, true);
  assert.equal(f.metrics.evaluations, 1);
  assert.equal(f.metrics.closes, 1);
});

test("persistent storage denial cannot turn a fallback revision into verification success", async (t) => {
  const f = await fixture(t);
  denyFinalScan(t, f, (read) => read >= 4);
  await f.run(f.options);
  assert.equal(f.metrics.calls.length, 2);
  assert.equal(f.metrics.process.exitCode, 2);
  assert.equal(f.metrics.output[0].targets[0].result.pass, false);
  assert.equal(f.metrics.output[0].targets[0].result.revisionMatches, false);
  assert.equal(f.metrics.closes, 1);
});

test("a second late scan denial escapes without a third payload read or fake success", async (t) => {
  const f = await fixture(t);
  const error = denyFinalScan(t, f, (read) => read === 4 || read === 8);
  await assert.rejects(f.run(f.options), (caught) => caught === error);
  assert.equal(f.metrics.calls.length, 2);
  assert.equal(f.metrics.evaluations, 0);
  assert.equal(f.metrics.output.length, 0);
  assert.equal(f.metrics.closes, 1);
});

test("non-transient library errors are not retried", async (t) => {
  const f = await fixture(t);
  const error = denyFinalScan(t, f, (read) => read === 4,
    Object.assign(new Error("fixture unexpected filesystem error"), { code: "EINVAL" }));
  await assert.rejects(f.run(f.options), (caught) => caught === error);
  assert.equal(f.metrics.calls.length, 1);
  assert.equal(f.metrics.evaluations, 0);
  assert.equal(f.metrics.closes, 1);
});

test("invalid configuration is not retried or accepted", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.preference, "{invalid");
  await assert.rejects(f.run(f.options), SyntaxError);
  assert.equal(f.metrics.calls.length, 1);
  assert.equal(f.metrics.evaluations, 0);
});

test("a linked storage root remains a non-retryable security error", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.root, "linked-library");
  await fs.symlink(f.external, linked, "dir");
  await fs.writeFile(f.preference, JSON.stringify({ schemaVersion: 1, libraryRoot: linked }));
  await assert.rejects(f.run(f.options), /must not be a symbolic link/);
  assert.equal(f.metrics.calls.length, 1);
  assert.equal(f.metrics.evaluations, 0);
});

test("one-shot apply does not inherit verifier-only storage retries", async (t) => {
  const f = await fixture(t);
  const error = denyFinalScan(t, f, (read) => read === 4);
  await assert.rejects(f.run({ ...f.options, mode: "once", operationToken: "fixture" }), (caught) => caught === error);
  assert.equal(f.metrics.calls.length, 1);
  assert.equal(f.metrics.evaluations, 0);
});
