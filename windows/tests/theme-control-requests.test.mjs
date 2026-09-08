import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLatestThemeActionRequest,
  validateThemeActionRequest,
} from "../scripts/theme-action-request.mjs";
import { presentThemeLibraryStatus } from "../scripts/injector.mjs";
import { selectLatestThemeRequest, validateThemeRequest } from "../scripts/theme-request.mjs";

const context = {
  currentThemeId: "com.mars.space-roamer",
  currentRevision: "revision-current",
  lastSequence: 4,
  now: 10_000,
  maxAgeMs: 2_000,
};

test("Windows native-mode actions are fresh, sequenced, and generation-bound", () => {
  const request = {
    action: "restore-default-theme",
    themeId: context.currentThemeId,
    generation: context.currentRevision,
    issuedAt: 9_500,
    sequence: 5,
  };
  assert.deepEqual(validateThemeActionRequest(request, context), request);
  assert.equal(validateThemeActionRequest({ ...request, sequence: 4 }, context), null);
  assert.equal(validateThemeActionRequest({ ...request, generation: "revision-old" }, context), null);
  assert.equal(validateThemeActionRequest({ ...request, issuedAt: 1_000 }, context), null);
  assert.equal(validateThemeActionRequest({ ...request, action: "delete-everything" }, context), null);
});

test("exposed Windows library actions validate with generation binding", () => {
  const base = {
    themeId: context.currentThemeId,
    generation: context.currentRevision,
    issuedAt: 9_500,
    sequence: 5,
  };
  assert.deepEqual(validateThemeActionRequest({ ...base, action: "import-media" }, context), {
    ...base,
    action: "import-media",
  });
  assert.deepEqual(validateThemeActionRequest({
    ...base,
    action: "delete-theme",
    targetThemeId: "com.mars.old-theme",
  }, context), {
    ...base,
    action: "delete-theme",
    targetThemeId: "com.mars.old-theme",
  });
  assert.equal(validateThemeActionRequest({ ...base, action: "delete-theme" }, context), null);
});

test("Windows theme requests can re-enter the active theme from native mode", () => {
  const request = {
    id: context.currentThemeId,
    fromThemeId: context.currentThemeId,
    generation: context.currentRevision,
    issuedAt: 9_500,
    sequence: 5,
  };
  assert.deepEqual(validateThemeRequest(request, context), request);
  assert.equal(validateThemeRequest({ ...request, fromThemeId: "com.mars.other" }, context), null);
  assert.equal(validateThemeRequest({ ...request, sequence: 4 }, context), null);
});

test("the newest validated Windows renderer request wins", () => {
  assert.equal(selectLatestThemeActionRequest([
    { action: "restore-default-theme", issuedAt: 100, sequence: 1 },
    { action: "save-settings", issuedAt: 101, sequence: 1 },
  ]).action, "save-settings");
  assert.equal(selectLatestThemeRequest([
    { id: "com.mars.one", issuedAt: 100, sequence: 2 },
    { id: "com.mars.two", issuedAt: 100, sequence: 3 },
  ]).id, "com.mars.two");
});

test("Windows library action results reach the renderer status event", async () => {
  const calls = [];
  const session = {
    evaluate: async (expression, timeoutMs) => {
      calls.push({ expression, timeoutMs });
      return true;
    },
  };
  await presentThemeLibraryStatus(session, "operation-1", "success", "已添加并应用主题");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 1500);
  assert.match(calls[0].expression, /codex-dynamic-skin-library-status/);
  assert.match(calls[0].expression, /"state":"success"/);
});
