import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLatestThemeActionRequest,
  validateThemeActionRequest,
} from "../../macos/scripts/theme-action-request.mjs";

const settings = {
  schemaVersion: 1,
  backgroundPlayback: true,
  soundEnabled: false,
  masterVolume: 1,
  ambientVolume: 0.7,
  uiVolume: 0.8,
  visualOpacity: 1,
  ambientMuted: false,
  uiMuted: false,
  quality: "auto",
  reducedMotion: "system",
  hiddenAudio: "pause",
};

test("theme library actions are fresh, sequenced, and bound to the active generation", () => {
  const context = {
    currentThemeId: "com.mars.starlight-in-eyes",
    currentRevision: "revision-a",
    lastSequence: 3,
    now: 10_000,
    maxAgeMs: 2_000,
  };
  const valid = {
    action: "delete-theme",
    themeId: context.currentThemeId,
    targetThemeId: "com.mars.local.media-dbbb8ca8e44ae1a7",
    generation: context.currentRevision,
    issuedAt: 9_500,
    sequence: 4,
  };
  assert.deepEqual(validateThemeActionRequest(valid, context), valid);
  const { targetThemeId: _targetThemeId, ...nonDelete } = valid;
  assert.deepEqual(validateThemeActionRequest({ ...nonDelete, action: "change-storage" }, context),
    { ...nonDelete, action: "change-storage" });
  assert.deepEqual(validateThemeActionRequest({ ...nonDelete, action: "restore-default-theme" }, context),
    { ...nonDelete, action: "restore-default-theme" });
  assert.equal(validateThemeActionRequest({ ...valid, targetThemeId: undefined }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, targetThemeId: "not a theme id" }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, action: "erase-everything" }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, themeId: "com.mars.other" }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, generation: "revision-old" }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, issuedAt: 1_000 }, context), null);
  assert.equal(validateThemeActionRequest({ ...valid, sequence: 3 }, context), null);
  assert.equal(validateThemeActionRequest("delete-theme", context), null);
});

test("the newest validated library action wins across renderers", () => {
  assert.deepEqual(selectLatestThemeActionRequest([
    { action: "import-media", themeId: "com.mars.active", generation: "g", issuedAt: 100, sequence: 4 },
    { action: "delete-theme", themeId: "com.mars.active", generation: "g", issuedAt: 101, sequence: 1 },
    { action: "import-media", themeId: "com.mars.active", generation: "g", issuedAt: 101, sequence: 2 },
  ]), {
    action: "import-media", themeId: "com.mars.active", generation: "g", issuedAt: 101, sequence: 2,
  });
});

test("save-settings accepts only the exact dynamic settings contract", () => {
  const context = {
    currentThemeId: "com.mars.starlight-in-eyes",
    currentRevision: "revision-a",
    lastSequence: 0,
    now: 10_000,
  };
  const request = {
    action: "save-settings",
    themeId: context.currentThemeId,
    generation: context.currentRevision,
    issuedAt: 9_900,
    sequence: 1,
    settings: { ...settings, backgroundPlayback: false, masterVolume: 0.35 },
  };
  const validated = validateThemeActionRequest(request, context);
  assert.deepEqual(validated, request);
  assert.equal(Object.isFrozen(validated.settings), true);
  assert.equal(validateThemeActionRequest({ ...request, settings: { ...request.settings, surprise: true } }, context), null);
  assert.equal(validateThemeActionRequest({ ...request, settings: { ...request.settings, masterVolume: 5 } }, context), null);
  assert.equal(validateThemeActionRequest({ ...request, settings: undefined }, context), null);
});
