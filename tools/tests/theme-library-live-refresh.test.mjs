import assert from "node:assert/strict";
import test from "node:test";

import { payloadWatchPlan } from "../../macos/scripts/injector.mjs";

test("watcher observes the active theme, static assets, and external library catalog", () => {
  assert.deepEqual(payloadWatchPlan("/tmp/theme", "/tmp/assets", "/tmp/external-themes"), [
    { directory: "/tmp/theme", kind: "theme", recursive: false },
    { directory: "/tmp/assets", kind: "static", recursive: false },
    { directory: "/tmp/external-themes", kind: "catalog", recursive: true },
  ]);
});

test("watch plan avoids duplicate directory watchers", () => {
  assert.deepEqual(payloadWatchPlan("/tmp/theme", "/tmp/assets", "/tmp/theme"), [
    { directory: "/tmp/theme", kind: "theme", recursive: true },
    { directory: "/tmp/assets", kind: "static", recursive: false },
  ]);
});
