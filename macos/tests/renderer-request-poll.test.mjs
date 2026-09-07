import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as injector from "../scripts/injector.mjs";

const { pollRendererRequests } = injector;

const injectorSource = await readFile(
  fileURLToPath(new URL("../scripts/injector.mjs", import.meta.url)),
  "utf8",
);

test("theme and action requests are read in one bounded renderer evaluation", async () => {
  const calls = [];
  const session = {
    async evaluate(expression, timeoutMs) {
      calls.push({ expression, timeoutMs });
      return { themeRequest: { id: "theme-a" }, actionRequest: { action: "save-settings" } };
    },
  };

  const result = await pollRendererRequests(session);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 1500);
  assert.match(calls[0].expression, /__CODEX_DYNAMIC_SKIN_THEME_REQUEST__/);
  assert.match(calls[0].expression, /__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__/);
  assert.equal(result.themeRequest.id, "theme-a");
  assert.equal(result.actionRequest.action, "save-settings");
});

test("the watcher uses bounded integrity checks and coalesced recovery thresholds", () => {
  assert.match(
    injectorSource,
    /verifyLoadedSessionOnce\(record\.session, current, 1500\)[\s\S]*record\.healthFailureCount < 2[\s\S]*record\.recoveryQueue\.request\("health-check"\)/,
  );
  assert.match(
    injectorSource,
    /pollRendererRequests\(record\.session, 1500\)[\s\S]*record\.pollFailureCount >= 3[\s\S]*record\.recoveryQueue\.request\("request-poll-failed"\)/,
  );
  assert.match(
    injectorSource,
    /record\.nextHealthCheckAt = healthNow \+ 4000/,
  );
});

test("renderer recovery cannot commit a stale theme generation", () => {
  assert.match(
    injectorSource,
    /for \(let recoveryAttempt = 0; recoveryAttempt < 3; recoveryAttempt \+= 1\)[\s\S]*const loaded = current;[\s\S]*loaded !== current[\s\S]*continue;/,
  );
  assert.match(
    injectorSource,
    /record\.earlyRevision !== loaded\.revision[\s\S]*registerEarlyForRecord\([\s\S]*record\.earlyRevision = loaded\.revision/,
  );
});

test("only a dynamic page reload waits for the early generation marker", () => {
  assert.equal(
    injector.shouldWaitForEarlyGeneration("Page.loadEventFired", { dynamicRenderer: true }),
    true,
  );
  assert.equal(
    injector.shouldWaitForEarlyGeneration("health-check", { dynamicRenderer: true }),
    false,
    "an in-document ownership repair must not spend 10.5 seconds waiting for a missing navigation marker",
  );
  assert.equal(
    injector.shouldWaitForEarlyGeneration("request-poll-failed", { dynamicRenderer: true }),
    false,
  );
  assert.equal(
    injector.shouldWaitForEarlyGeneration("Page.loadEventFired", { dynamicRenderer: false }),
    false,
  );
  assert.match(
    injectorSource,
    /if \(shouldWaitForEarlyGeneration\(reason, loaded\)\) \{[\s\S]*?waitForEarlyGenerationApplied\([\s\S]*?record\.session,[\s\S]*?loaded\.revision,[\s\S]*?earlyGenerationWaitOptions\(reason\)[\s\S]*?cancelPendingEarlyGeneration\(record\.session, loaded\.revision\)/,
    "the live recovery branch must use the reason-aware wait policy",
  );
});
