import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../../runtime/dynamic/theme-contract.mjs", import.meta.url);
const contractFileUrl = new URL("../../runtime/dynamic/theme-contract.json", import.meta.url);
const videoFixtureUrl = new URL("fixtures/themes/v2-video/theme.json", import.meta.url);
const voxelFixtureUrl = new URL("fixtures/themes/v2-voxel/theme.json", import.meta.url);

let contractModule = null;
try {
  contractModule = await import(moduleUrl);
} catch {
  // The first TDD run intentionally reaches this assertion before the module exists.
}

function requireContract() {
  assert.ok(contractModule, "Skin API v2 contract module must exist");
  return contractModule;
}

async function readJson(url) {
  return JSON.parse(await fs.readFile(url, "utf8"));
}

function declaredVideoAssets() {
  return [
    "audio/ui/approval.wav",
    "audio/ui/completed.wav",
    "audio/ui/error.wav",
    "media/loop.mp4",
    "media/poster.webp",
    "styles/theme.css",
  ];
}

test("validates a video theme whose embedded track is ambient audio", async () => {
  const { validateThemeDefinition } = requireContract();
  const theme = await readJson(videoFixtureUrl);

  const result = validateThemeDefinition(theme, declaredVideoAssets());

  assert.equal(result.visual.kind, "video");
  assert.equal(result.audio.ambient.source, "visual");
  assert.equal(result.audio.ambient.asset, undefined);
  assert.equal(result.audio.ui.events.taskCompleted, "audio/ui/completed.wav");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.audio.ui.events), true);
});

test("accepts the first-party adaptive video fit without allowing arbitrary fit modes", async () => {
  const { validateThemeDefinition } = requireContract();
  const theme = await readJson(videoFixtureUrl);
  theme.visual.fit = "adaptive";

  const result = validateThemeDefinition(theme, declaredVideoAssets());

  assert.equal(result.visual.fit, "adaptive");
  theme.visual.fit = "stretch";
  assert.throws(
    () => validateThemeDefinition(theme, declaredVideoAssets()),
    (error) => error?.code === "VALUE_FORMAT" && /theme\.visual\.fit/.test(error.message),
  );
});

test("accepts bounded video overscan for removing encoded letterbox bars", async () => {
  const { validateThemeDefinition } = requireContract();
  const theme = await readJson(videoFixtureUrl);
  theme.visual.overscan = 1.12;
  const result = validateThemeDefinition(theme, declaredVideoAssets());
  assert.equal(result.visual.overscan, 1.12);
  theme.visual.overscan = 1.4;
  assert.throws(
    () => validateThemeDefinition(theme, declaredVideoAssets()),
    (error) => error?.code === "VALUE_RANGE" && /theme\.visual\.overscan/.test(error.message),
  );
});

test("validates a separate ambient asset without treating video audio as ambient", async () => {
  const { validateThemeDefinition } = requireContract();
  const theme = await readJson(videoFixtureUrl);
  theme.audio.ambient = {
    source: "asset",
    asset: "audio/ambient.m4a",
    loop: true,
    volume: 0.35,
    analyze: true,
  };
  const declared = [...declaredVideoAssets(), "audio/ambient.m4a"];

  const result = validateThemeDefinition(theme, declared);

  assert.equal(result.audio.ambient.source, "asset");
  assert.equal(result.audio.ambient.asset, "audio/ambient.m4a");
});

test("validates the first-party voxel-field effect and collects every asset", async () => {
  const { collectThemeAssetPaths, validateThemeDefinition } = requireContract();
  const theme = await readJson(voxelFixtureUrl);
  const declared = [
    "audio/ui/completed.wav",
    "media/fallback.mp4",
    "media/poster.webp",
    "styles/theme.css",
  ];

  const result = validateThemeDefinition(theme, declared);

  assert.equal(result.visual.effect, "voxel-field");
  assert.equal(result.effect.id, "voxel-field");
  assert.equal(result.effect.source, "ambient");
  assert.deepEqual(collectThemeAssetPaths(result), declared);
});

test("rejects remote and traversal asset paths", async () => {
  const { validateThemeDefinition } = requireContract();
  const remote = await readJson(videoFixtureUrl);
  remote.visual.asset = "https://example.com/loop.mp4";
  assert.throws(
    () => validateThemeDefinition(remote, declaredVideoAssets()),
    (error) => error?.code === "ASSET_PATH" && /relative package path/.test(error.message),
  );

  const traversal = await readJson(videoFixtureUrl);
  traversal.visual.asset = "media/../loop.mp4";
  assert.throws(
    () => validateThemeDefinition(traversal, declaredVideoAssets()),
    (error) => error?.code === "ASSET_PATH" && /relative package path/.test(error.message),
  );
});

test("rejects case-fold collisions in declared assets", async () => {
  const { validateThemeDefinition } = requireContract();
  const theme = await readJson(videoFixtureUrl);
  assert.throws(
    () => validateThemeDefinition(theme, [...declaredVideoAssets(), "Media/Loop.mp4"]),
    (error) => error?.code === "ASSET_COLLISION" && /case-fold collision/.test(error.message),
  );
});

test("rejects unknown fields and out-of-range effect parameters", async () => {
  const { validateThemeDefinition } = requireContract();
  const unknown = await readJson(videoFixtureUrl);
  unknown.script = "media/skin.js";
  assert.throws(
    () => validateThemeDefinition(unknown, declaredVideoAssets()),
    (error) => error?.code === "UNKNOWN_FIELD" && /script/.test(error.message),
  );

  const voxel = await readJson(voxelFixtureUrl);
  voxel.effect.parameters.gridSize = 65;
  assert.throws(
    () => validateThemeDefinition(voxel, [
      "audio/ui/completed.wav",
      "media/fallback.mp4",
      "media/poster.webp",
      "styles/theme.css",
    ]),
    (error) => error?.code === "VALUE_RANGE" && /gridSize/.test(error.message),
  );
});

test("rejects inconsistent capabilities and audio sources", async () => {
  const { validateThemeDefinition } = requireContract();
  const video = await readJson(videoFixtureUrl);
  video.capabilities = video.capabilities.filter((value) => value !== "sound-pack");
  assert.throws(
    () => validateThemeDefinition(video, declaredVideoAssets()),
    (error) => error?.code === "CAPABILITY_MISMATCH" && /sound-pack/.test(error.message),
  );

  const image = await readJson(videoFixtureUrl);
  image.capabilities = ["sound-pack", "safe-css"];
  image.visual = {
    kind: "image",
    asset: "media/poster.webp",
    fit: "cover",
    opacity: 1,
  };
  assert.throws(
    () => validateThemeDefinition(image, declaredVideoAssets()),
    (error) => error?.code === "AUDIO_SOURCE" && /video/.test(error.message),
  );
});

test("rejects unknown UI events and theme references absent from declared assets", async () => {
  const { validateThemeDefinition } = requireContract();
  const unknownEvent = await readJson(videoFixtureUrl);
  unknownEvent.audio.ui.events.messageReceived = "audio/ui/message.wav";
  assert.throws(
    () => validateThemeDefinition(unknownEvent, [...declaredVideoAssets(), "audio/ui/message.wav"]),
    (error) => error?.code === "UNKNOWN_FIELD" && /messageReceived/.test(error.message),
  );

  const missing = await readJson(videoFixtureUrl);
  assert.throws(
    () => validateThemeDefinition(missing, declaredVideoAssets().filter((path) => path !== "media/loop.mp4")),
    (error) => error?.code === "UNDECLARED_ASSET" && /media\/loop\.mp4/.test(error.message),
  );
});

test("normalizes Unicode package paths to NFC and accepts canonical Unicode assets", () => {
  const { canonicalAssetPath, validateThemeDefinition } = requireContract();
  assert.equal(canonicalAssetPath("media/cafe\u0301.webp"), "media/caf\u00e9.webp");

  const theme = {
    schemaVersion: 2,
    id: "com.example.unicode",
    name: "Cafe\u0301",
    version: "1.0.0",
    capabilities: [],
    visual: { kind: "image", asset: "media/caf\u00e9.webp" },
    audio: {
      ambient: { source: "none" },
      ui: { events: {} },
    },
  };
  const result = validateThemeDefinition(theme, ["media/caf\u00e9.webp"]);
  assert.equal(result.name, "Caf\u00e9");
  assert.equal(result.visual.asset, "media/caf\u00e9.webp");
});

test("publishes nested JSON Schema shapes instead of opaque objects", () => {
  const { THEME_CONTRACT_DOCUMENT } = requireContract();
  const properties = THEME_CONTRACT_DOCUMENT.properties;

  assert.equal(properties.visual.oneOf.length, 3);
  assert.equal(properties.audio.additionalProperties, false);
  assert.deepEqual(properties.audio.required, ["ambient", "ui"]);
  assert.equal(properties.audio.properties.ambient.additionalProperties, false);
  assert.equal(properties.audio.properties.ui.properties.events.additionalProperties, false);
  assert.equal(properties.effect.additionalProperties, false);
  assert.equal(properties.tokens.additionalProperties, false);
});

test("requires disabled ambient and UI audio to be represented explicitly", () => {
  const { validateThemeDefinition } = requireContract();
  const theme = {
    schemaVersion: 2,
    id: "com.example.silent",
    name: "Silent",
    version: "1.0.0",
    capabilities: [],
    visual: { kind: "image", asset: "media/poster.webp" },
    audio: {
      ambient: { source: "none" },
      ui: {},
    },
  };

  assert.throws(
    () => validateThemeDefinition(theme, ["media/poster.webp"]),
    (error) => error?.code === "MISSING_FIELD" && /events/.test(error.message),
  );
});

test("prints the checked-in JSON contract deterministically", async () => {
  requireContract();
  const expected = await fs.readFile(contractFileUrl, "utf8");
  const result = spawnSync(process.execPath, [fileURLToPath(moduleUrl), "--print-contract"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
});
