import assert from "node:assert/strict";
import test from "node:test";

import { nextOwnershipProbeState, nextRequestPollState } from "../scripts/injector.mjs";

test("Windows renderer transport failures back off without triggering reinjection", () => {
  let request = nextRequestPollState({}, "transport-error");
  assert.equal(request.recover, false);
  const requestDelay = request.delayMs;
  request = nextRequestPollState(request, "transport-error");
  assert.equal(request.recover, false);
  assert.ok(request.delayMs > requestDelay);

  let health = nextOwnershipProbeState({}, "transport-error");
  assert.equal(health.recover, false);
  const healthDelay = health.delayMs;
  health = nextOwnershipProbeState(health, "transport-error");
  assert.equal(health.recover, false);
  assert.ok(health.delayMs > healthDelay);
});

test("Windows repairs only after two confirmed ownership mismatches", () => {
  let health = nextOwnershipProbeState({}, "ownership-mismatch");
  assert.equal(health.recover, false);
  health = nextOwnershipProbeState(health, "ownership-mismatch");
  assert.equal(health.recover, true);
});
