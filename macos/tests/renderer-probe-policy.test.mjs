import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  nextDiscoveryPollState,
  nextOwnershipProbeState,
  nextRequestPollState,
  oneShotHardDeadlineMs,
  probeLoadedThemeOwnership,
  shouldAdoptLoadedTheme,
  steadyStateWatchDelay,
} from "../scripts/injector.mjs";

test("one-shot verification has a bounded wall-clock deadline", () => {
  assert.equal(oneShotHardDeadlineMs({ timeoutMs: 20_000 }), 35_000);
  assert.equal(oneShotHardDeadlineMs({ timeoutMs: 120_000 }), 135_000);
  assert.equal(oneShotHardDeadlineMs({ timeoutMs: Number.NaN }), 35_000);
});

test("steady injected sessions use a quiet outer discovery cadence", () => {
  assert.equal(steadyStateWatchDelay(1, 1), 2_000);
  assert.equal(steadyStateWatchDelay(2, 2), 2_000);
  assert.ok(steadyStateWatchDelay(0, 1) < 2_000);
});

test("watcher restart adopts an identical healthy theme without rebuilding it", () => {
  const current = {
    displayMode: "theme",
    sourceApiVersion: 2,
    theme: { id: "com.example.theme" },
    revision: "revision-1",
  };
  const healthy = {
    ownershipProbe: true,
    installed: true,
    version: "1.5.17",
    themeId: "com.example.theme",
    revision: "revision-1",
    stylePresent: true,
    documentVisibility: "visible",
    dynamicRootCount: 1,
    dynamicVisibleRootCount: 1,
    dynamic: { activation: "active", diagnostics: { phase: "active" } },
  };
  assert.equal(shouldAdoptLoadedTheme(healthy, current), true);
  assert.equal(shouldAdoptLoadedTheme({ ...healthy, revision: "old" }, current), false);
  assert.equal(shouldAdoptLoadedTheme({ ...healthy, dynamicRootCount: 0 }, current), false);
});

test("transient renderer discovery failures back off and a successful probe resets the budget", () => {
  let state = nextDiscoveryPollState({}, "transport-error");
  assert.ok(state.delayMs >= 1_000);
  for (let index = 0; index < 6; index += 1) {
    state = nextDiscoveryPollState(state, "transport-error");
  }
  assert.equal(state.delayMs, 30_000);
  assert.equal(state.transportFailures, 7);
  assert.deepEqual(nextDiscoveryPollState(state, "healthy"), {
    transportFailures: 0,
    delayMs: 100,
  });
  assert.equal(nextDiscoveryPollState(nextDiscoveryPollState(state, "healthy"), "transport-error").transportFailures, 1);
});

test("persistent discovery loss exits the watcher instead of reporting an alive but unusable injector", () => {
  let state = {};
  for (let attempt = 0; attempt < 7; attempt += 1) {
    state = nextDiscoveryPollState(state, "transport-error");
  }
  assert.throws(() => nextDiscoveryPollState(state, "transport-error"), {
    code: "CDP_DISCOVERY_UNAVAILABLE",
  });
});

test("transport timeouts back off without pretending the theme lost ownership", () => {
  let state = nextOwnershipProbeState({}, "transport-error");
  assert.equal(state.recover, false);
  const firstDelay = state.delayMs;
  state = nextOwnershipProbeState(state, "transport-error");
  assert.equal(state.recover, false);
  assert.ok(state.delayMs > firstDelay);
  assert.ok(state.delayMs <= 30_000);
});

test("only two explicit ownership mismatches request an in-place repair", () => {
  let state = nextOwnershipProbeState({}, "ownership-mismatch");
  assert.equal(state.recover, false);
  state = nextOwnershipProbeState(state, "ownership-mismatch");
  assert.equal(state.recover, true);
});

test("request polling transport failures only back off", () => {
  let state = nextRequestPollState({}, "transport-error");
  assert.equal(state.recover, false);
  const firstDelay = state.delayMs;
  state = nextRequestPollState(state, "transport-error");
  assert.equal(state.recover, false);
  assert.ok(state.delayMs > firstDelay);
});

test("periodic ownership probe stays lightweight", async () => {
  let expression = "";
  const runtime = {
    version: "1.5.17", themeId: "com.example.theme", revision: "revision-1",
    styleMode: "style", styleNode: {}, dynamic: { activation: "active" },
  };
  const session = { async evaluate(source) {
    expression = source;
    return vm.runInNewContext(source, {
      window: { __CODEX_DREAM_SKIN_STATE__: runtime },
      document: {
        documentElement: { getAttribute: () => "active" },
        getElementById: () => runtime.styleNode,
        querySelectorAll: () => [{ isConnected: true }],
        adoptedStyleSheets: [],
      },
    });
  } };
  const result = await probeLoadedThemeOwnership(session, {
    displayMode: "theme", sourceApiVersion: 2,
    theme: { id: "com.example.theme" }, revision: "revision-1",
  });
  assert.equal(result.dynamicRootCount, 1);
  assert.equal(result.ownershipProbe, true);
  assert.equal("businessClassPollution" in result, false);
  assert.equal("documentOverflow" in result, false);
  assert.doesNotMatch(expression, /diagnostics\s*\(/u);
  assert.doesNotMatch(expression, /querySelectorAll\('\[class\]'\)/u);
});
