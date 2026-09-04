import assert from "node:assert/strict";
import test from "node:test";

import { payloadWatchPlan } from "../scripts/injector.mjs";

test("theme library changes are watched recursively while active assets stay shallow", () => {
  const plan = payloadWatchPlan(
    "/fixture/themes/current",
    "/fixture/runtime-assets",
    "/fixture/themes",
  );

  assert.deepEqual(plan.map(({ kind, recursive }) => ({ kind, recursive })), [
    { kind: "theme", recursive: false },
    { kind: "static", recursive: false },
    { kind: "catalog", recursive: true },
  ]);
});
