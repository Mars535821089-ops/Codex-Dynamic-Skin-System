import assert from "node:assert/strict";
import test from "node:test";

import { pollRendererRequests } from "../scripts/injector.mjs";

test("Windows theme and action requests share one bounded renderer evaluation", async () => {
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
