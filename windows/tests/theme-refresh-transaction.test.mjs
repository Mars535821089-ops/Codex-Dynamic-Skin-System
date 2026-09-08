import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// Exercise the real watcher transaction without opening a CDP socket or app.
// Only its native renderer/persistence boundaries are replaced by this harness.
const source = await fs.readFile(new URL("../scripts/injector.mjs", import.meta.url), "utf8");
const start = source.indexOf("  const refreshPayload = async ");
const end = source.indexOf("  const libraryController = ", start);
assert.ok(start >= 0 && end > start, "The real watcher refresh transaction must remain covered");

function fixture({ releaseOldFails = false, failVerificationAt = null, failSelection = false } = {}) {
  const events = [];
  const oldAssets = { released: false, async release() {
    this.released = true; events.push("release-old");
    if (releaseOldFails) throw new Error("EBUSY old snapshot cleanup");
  } };
  const newAssets = { released: false, async release() { this.released = true; events.push("release-new"); } };
  const previous = { revision: "old", payload: "old", theme: { id: "local.test.old" }, assetGeneration: oldAssets };
  const next = { revision: "new", payload: "new", theme: { id: "local.test.new" }, assetGeneration: newAssets };
  const sessions = new Map(["r1", "r2"].map((id) => [id, { id, closed: false,
    close() { this.closed = true; } }]));
  const state = { selectedThemeDir: "/old", displayMode: "theme", loadedPayload: previous,
    loadWatchedPayload: async () => next, recoveryQueues: new Map(), libraryMutation: false, paused: false,
    sessions, readyTargets: new Set(sessions.keys()), options: { timeoutMs: 8000 },
    registerEarlyPayload: async (session) => `new-${session.id}`,
    applyToSession: async (session, payload) => events.push(`render-${session.id}-${payload}`),
    waitForVerifiedSession: async (_session, id, _timeout, _theme, revision) => ({
      pass: !(revision === "new" && id === failVerificationAt),
    }),
    expectsVisibleDynamicRoot: () => true, selectionFile: "/selection",
    persisted: "local.test.old",
    writeThemeSelection: async (_file, id) => {
      if (failSelection) throw new Error("EACCES selected theme");
      state.persisted = id; events.push(`persist-${id}`);
    },
    earlyScripts: new Map([...sessions.keys()].map((id) => [id, `old-${id}`])),
    removeEarlyPayload: async (_session, identifier) => events.push(`remove-${identifier}`),
    fallbackTargets: new Map(), console: { log() {}, warn() {}, error() {} },
  };
  const refresh = new Function("state", `with (state) { ${source.slice(start, end)}; return refreshPayload; }`)(state);
  return { state, previous, next, oldAssets, newAssets, events,
    refresh: () => refresh("/new", "transaction-test", "theme", next) };
}

test("post-commit snapshot cleanup failure does not roll back committed theme state", async () => {
  const f = fixture({ releaseOldFails: true });
  await assert.doesNotReject(f.refresh);
  assert.equal(f.state.loadedPayload, f.next);
  assert.equal(f.state.selectedThemeDir, "/new");
  assert.equal(f.state.persisted, "local.test.new");
  assert.equal(f.newAssets.released, false);
  assert.equal(f.oldAssets.released, true);
  assert.equal(f.state.libraryMutation, false);
  for (const id of f.state.sessions.keys()) {
    assert.equal(f.state.earlyScripts.get(id), `new-${id}`);
    assert.equal(f.state.readyTargets.has(id), true);
    assert.equal(f.events.includes(`render-${id}-old`), false);
    assert.equal(f.events.includes(`remove-new-${id}`), false);
  }
});

test("a later renderer verification failure restores every attempted renderer before releasing candidate assets", async () => {
  const f = fixture({ failVerificationAt: "r2" });
  await assert.rejects(f.refresh, /verification/i);
  assert.equal(f.state.loadedPayload, f.previous);
  assert.equal(f.state.persisted, "local.test.old");
  assert.equal(f.state.selectedThemeDir, "/old");
  assert.equal(f.oldAssets.released, false);
  assert.equal(f.newAssets.released, true);
  for (const id of f.state.sessions.keys()) {
    assert.equal(f.state.earlyScripts.get(id), `old-${id}`);
    assert.equal(f.events.includes(`remove-old-${id}`), false);
    assert.ok(f.events.indexOf(`render-${id}-old`) < f.events.indexOf("release-new"));
  }
});

test("selection persistence failure restores renderer state and preserves old early scripts and assets", async () => {
  const f = fixture({ failSelection: true });
  await assert.rejects(f.refresh, /EACCES/);
  assert.equal(f.state.loadedPayload, f.previous);
  assert.equal(f.state.persisted, "local.test.old");
  assert.equal(f.oldAssets.released, false);
  assert.equal(f.newAssets.released, true);
  for (const id of f.state.sessions.keys()) {
    assert.equal(f.state.earlyScripts.get(id), `old-${id}`);
    assert.equal(f.state.readyTargets.has(id), true);
    assert.equal(f.events.includes(`render-${id}-old`), true);
    assert.equal(f.events.includes(`remove-old-${id}`), false);
  }
});

const watchStart = source.indexOf("  const applyExternalSelection = async ");
const watchEnd = source.indexOf("  try {\n    loadedPayload = ", watchStart);
assert.ok(watchStart >= 0 && watchEnd > watchStart, "The real watcher retry gates must remain covered");

function watchFixture() {
  const calls = { selectionReads: 0, loads: 0, refreshes: 0, releases: 0, stamps: 0 };
  const state = {
    selectionFile: "/selection", displayMode: "theme", selectedThemeDir: "/old",
    loadedPayload: { theme: { id: "local.test.old" }, revision: "old", sourceApiVersion: 2, sourceStamp: "old" },
    selection: { themeId: "local.test.new", mode: "theme" },
    selectionStat: { dev: 1, ino: 2, size: 100, mtimeMs: 1, ctimeMs: 1 },
    rejectedExternalSelectionKey: null, rejectedSourceRevision: null, nextSourceRetryAt: 0,
    lastStrongThemeAuditAt: 0, STRONG_THEME_AUDIT_MS: 30000, options: { themeDir: "/old" },
    candidateRevision: "new", failLoad: false, failRefresh: true,
    readThemeSelection: async () => { calls.selectionReads++; return state.selection; },
    fs: { lstat: async () => state.selectionStat },
    readThemeSourceStamp: async () => { calls.stamps++; return "changed"; },
    refreshPayload: async (_dir, _reason, mode, candidate) => {
      calls.refreshes++;
      if (state.failRefresh) throw new Error("Candidate renderer verification rejected");
      state.loadedPayload = candidate;
      state.displayMode = mode;
    },
  };
  const load = async () => {
    calls.loads++;
    if (state.failLoad) throw new Error("Incomplete source asset");
    return { theme: { id: state.selection.themeId }, revision: state.candidateRevision,
      themeDir: "/new", sourceApiVersion: 2, sourceStamp: "changed", displayMode: state.selection.mode,
      assetGeneration: { async release() { calls.releases++; } } };
  };
  state.loadPayloadForOptions = load;
  state.loadWatchedPayload = load;
  state.loadPayload = load;
  state.dynamicRuntimeForOptions = () => ({});
  const watcher = new Function("state", `with (state) { ${source.slice(watchStart, watchEnd)};
    return { applyExternalSelection, auditThemeSource }; }`)(state);
  return { state, calls, ...watcher };
}

test("an unchanged rejected external selection is applied once, while an explicit rewrite retries immediately", async () => {
  const f = watchFixture();
  await assert.rejects(f.applyExternalSelection, /verification rejected/);
  const rejected = f.state.rejectedExternalSelectionKey;
  for (let count = 0; count < 5; count++) await f.applyExternalSelection();
  assert.equal(f.calls.loads, 1);
  assert.equal(f.calls.refreshes, 1);
  assert.equal(f.state.loadedPayload.revision, "old");
  assert.equal(f.state.rejectedExternalSelectionKey, rejected);

  // The same theme can be intentionally retried without choosing another theme.
  f.state.selectionStat = { ...f.state.selectionStat, mtimeMs: 2, ctimeMs: 2 };
  f.state.failRefresh = false;
  await f.applyExternalSelection();
  assert.equal(f.calls.loads, 2);
  assert.equal(f.calls.refreshes, 2);
  assert.equal(f.state.loadedPayload.revision, "new");
  assert.equal(f.state.rejectedExternalSelectionKey, null);
  await f.applyExternalSelection();
  assert.equal(f.calls.refreshes, 2, "An already active choice needs no reapplication");
});

test("an external candidate that cannot load is also gated until a new request is written", async () => {
  const f = watchFixture();
  f.state.failLoad = true;
  await assert.rejects(f.applyExternalSelection, /Incomplete source/);
  await f.applyExternalSelection();
  assert.equal(f.calls.loads, 1);
  assert.equal(f.calls.refreshes, 0);
  f.state.selectionStat = { ...f.state.selectionStat, ino: 3 };
  await assert.rejects(f.applyExternalSelection, /Incomplete source/);
  assert.equal(f.calls.loads, 2, "An atomic selection replacement is a new request");
});

test("a new user theme or display-mode choice is not blocked by a previous failed selection", async () => {
  for (const selection of [
    { themeId: "local.test.other", mode: "theme" },
    { themeId: "local.test.new", mode: "native" },
  ]) {
    const f = watchFixture();
    await assert.rejects(f.applyExternalSelection, /verification rejected/);
    // Deliberately retain identical stat fields: the choice itself changes the key.
    f.state.selection = selection;
    f.state.failRefresh = false;
    await f.applyExternalSelection();
    assert.equal(f.calls.refreshes, 2);
    assert.equal(f.state.loadedPayload.theme.id, selection.themeId);
    assert.equal(f.state.displayMode, selection.mode);
    assert.equal(f.state.rejectedExternalSelectionKey, null);
  }
});

test("source rejection backs off and never reapplies the same failed revision, but a new revision can succeed", async () => {
  const f = watchFixture();
  await assert.rejects(() => f.auditThemeSource(1000), /verification rejected/);
  assert.equal(f.state.rejectedSourceRevision, "new");
  assert.equal(f.state.nextSourceRetryAt, 31000);
  for (const now of [1001, 2200, 10000, 30999]) await f.auditThemeSource(now);
  assert.equal(f.calls.loads, 1);
  assert.equal(f.calls.refreshes, 1);
  assert.equal(f.calls.stamps, 1, "Cooldown must also avoid repeatedly reading failing sources");

  await f.auditThemeSource(31000);
  assert.equal(f.calls.loads, 2, "A periodic audit can detect repaired source content");
  assert.equal(f.calls.refreshes, 1, "The same rejected revision must not flash again");
  assert.equal(f.calls.releases, 1, "An unused prepared candidate must release its hosted assets");
  assert.equal(f.state.nextSourceRetryAt, 61000);

  f.state.candidateRevision = "repaired";
  f.state.failRefresh = false;
  await f.auditThemeSource(61000);
  assert.equal(f.calls.loads, 3);
  assert.equal(f.calls.refreshes, 2);
  assert.equal(f.state.loadedPayload.revision, "repaired");
  assert.equal(f.state.rejectedSourceRevision, null);
  assert.equal(f.state.nextSourceRetryAt, 0);
});

test("source loader failures receive the same bounded retry interval before a fingerprint exists", async () => {
  const f = watchFixture();
  f.state.failLoad = true;
  await assert.rejects(() => f.auditThemeSource(1000), /Incomplete source/);
  for (const now of [1001, 10000, 30999]) await f.auditThemeSource(now);
  assert.equal(f.calls.loads, 1);
  assert.equal(f.calls.refreshes, 0);
  assert.equal(f.state.rejectedSourceRevision, null);
  assert.equal(f.state.nextSourceRetryAt, 31000);
  f.state.failLoad = false;
  f.state.failRefresh = false;
  await f.auditThemeSource(31000);
  assert.equal(f.calls.loads, 2);
  assert.equal(f.calls.refreshes, 1);
  assert.equal(f.state.nextSourceRetryAt, 0);
});
