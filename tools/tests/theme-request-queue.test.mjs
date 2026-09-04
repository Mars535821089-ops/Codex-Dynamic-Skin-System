import assert from "node:assert/strict";
import test from "node:test";
import {
  createLatestThemeRequestQueue,
  validateThemeRequest,
  selectLatestThemeRequest,
} from "../../macos/scripts/theme-request-queue.mjs";

test("theme requests are bound to the active source generation and a fresh sequence", () => {
  const current = {
    currentThemeId: "com.mars.starlight-in-eyes",
    currentRevision: "revision-a",
    lastSequence: 4,
    now: 10_000,
    maxAgeMs: 2_000,
  };
  const valid = {
    id: "com.mars.space-roamer",
    fromThemeId: current.currentThemeId,
    generation: current.currentRevision,
    issuedAt: 9_500,
    sequence: 5,
  };
  assert.deepEqual(validateThemeRequest(valid, current), valid);
  assert.equal(validateThemeRequest({ ...valid, fromThemeId: "com.mars.other" }, current), null);
  assert.equal(validateThemeRequest({ ...valid, generation: "revision-old" }, current), null);
  assert.equal(validateThemeRequest({ ...valid, issuedAt: 1_000 }, current), null);
  assert.equal(validateThemeRequest({ ...valid, sequence: 4 }, current), null);
  assert.equal(validateThemeRequest("com.mars.space-roamer", current), null);
});

test("a queued request becomes stale as soon as its source generation is replaced", async () => {
  let active = { id: "theme-a", revision: "revision-a" };
  const applied = [];
  const queue = createLatestThemeRequestQueue({
    settleMs: 1,
    apply: async (request) => {
      if (request.fromThemeId !== active.id || request.generation !== active.revision) return;
      applied.push(request.id);
      active = { id: request.id, revision: `revision-${request.id}` };
    },
  });
  queue.request({ id: "theme-b", fromThemeId: "theme-a", generation: "revision-a" });
  await new Promise((resolve) => setTimeout(resolve, 3));
  queue.request({ id: "theme-c", fromThemeId: "theme-a", generation: "revision-a" });
  await queue.idle();
  assert.deepEqual(applied, ["theme-b"]);
  queue.close();
});

test("renderer requests are drained together and the newest request wins", () => {
  assert.deepEqual(selectLatestThemeRequest([
    "old-string-request",
    { id: "newer", fromThemeId: "source", generation: "gen", issuedAt: 200, sequence: 1 },
    { id: "newest", fromThemeId: "source", generation: "gen", issuedAt: 200, sequence: 2 },
  ]), {
    id: "newest", fromThemeId: "source", generation: "gen", issuedAt: 200, sequence: 2,
  });
});

test("rapid requests are coalesced before applying", async () => {
  const applied = [];
  const queue = createLatestThemeRequestQueue({
    settleMs: 10,
    apply: async (request) => applied.push(request.id),
  });
  queue.request({ id: "one" });
  queue.request({ id: "two" });
  queue.request({ id: "final" });
  await queue.idle();
  assert.deepEqual(applied, ["final"]);
  queue.close();
});

test("requests arriving during an apply skip intermediate themes", async () => {
  const applied = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = createLatestThemeRequestQueue({
    settleMs: 5,
    apply: async (request) => {
      applied.push(request.id);
      if (request.id === "first") await firstPending;
    },
  });
  queue.request({ id: "first" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.request({ id: "middle" });
  queue.request({ id: "final" });
  releaseFirst();
  await queue.idle();
  assert.deepEqual(applied, ["first", "final"]);
  queue.close();
});

test("clearing a pending request settles the queue without applying it", async () => {
  const applied = [];
  const queue = createLatestThemeRequestQueue({
    settleMs: 1000,
    apply: async (request) => applied.push(request.id),
  });
  queue.request({ id: "discard-me" });
  queue.clear();
  await queue.idle();
  assert.deepEqual(applied, []);
  queue.close();
});
