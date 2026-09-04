import assert from "node:assert/strict";
import test from "node:test";

import { createRendererRecoveryQueue } from "../scripts/renderer-recovery-queue.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("coalesces repeated lifecycle events into one renderer recovery", async () => {
  const reasons = [];
  const queue = createRendererRecoveryQueue({
    isCurrent: () => true,
    recover: async (reason) => { reasons.push(reason); },
  });

  assert.equal(queue.request("Page.loadEventFired"), true);
  assert.equal(queue.request("Page.loadEventFired"), false);
  await tick();
  await queue.idle();
  assert.deepEqual(reasons, ["Page.loadEventFired"]);
  await queue.close();
});

test("an obsolete renderer record cannot mutate its replacement", async () => {
  let current = true;
  let recoveries = 0;
  const queue = createRendererRecoveryQueue({
    isCurrent: () => current,
    recover: async () => { recoveries += 1; },
  });

  assert.equal(queue.request("Page.loadEventFired", { delayMs: 5 }), true);
  current = false;
  await tick();
  await queue.idle();
  assert.equal(recoveries, 0);
  await queue.close();
});

test("a renderer recovery failure is isolated and reported once", async () => {
  const failures = [];
  const queue = createRendererRecoveryQueue({
    isCurrent: () => true,
    recover: async () => { throw new Error("renderer unavailable"); },
    onFailure: async (error, reason) => { failures.push([error.message, reason]); },
  });

  assert.equal(queue.request("health-check"), true);
  await tick();
  await queue.idle();
  assert.deepEqual(failures, [["renderer unavailable", "health-check"]]);
  assert.equal(queue.pending(), false);
  await queue.close();
});
