import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const settingsUrl = new URL("../../runtime/dynamic/settings.mjs", import.meta.url);

let settingsModule = null;
try {
  settingsModule = await import(settingsUrl);
} catch {
  // The first TDD run intentionally reaches requireSettings before implementation exists.
}

function requireSettings() {
  assert.ok(settingsModule, "dynamic settings contract module must exist");
  return settingsModule;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dynamic-settings-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const expectedDefaults = {
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

test("defaults keep sound disabled and are deeply frozen", () => {
  const { DEFAULT_DYNAMIC_SETTINGS } = requireSettings();

  assert.deepEqual(DEFAULT_DYNAMIC_SETTINGS, expectedDefaults);
  assert.equal(Object.isFrozen(DEFAULT_DYNAMIC_SETTINGS), true);
  assert.throws(() => { DEFAULT_DYNAMIC_SETTINGS.soundEnabled = true; }, TypeError);
});

test("validates every supported user-controlled mode without mutating input", () => {
  const { validateDynamicSettings } = requireSettings();
  const raw = {
    ...expectedDefaults,
    soundEnabled: true,
    quality: "balanced",
    reducedMotion: "on",
    hiddenAudio: "continue",
    backgroundPlayback: false,
  };

  const result = validateDynamicSettings(raw);

  assert.deepEqual(result, raw);
  assert.notEqual(result, raw);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(result.backgroundPlayback, false);

  for (const quality of ["auto", "full", "balanced", "media", "static"]) {
    assert.equal(validateDynamicSettings({ ...expectedDefaults, quality }).quality, quality);
  }
  for (const reducedMotion of ["system", "on", "off"]) {
    assert.equal(validateDynamicSettings({ ...expectedDefaults, reducedMotion }).reducedMotion, reducedMotion);
  }
  for (const hiddenAudio of ["pause", "continue"]) {
    assert.equal(validateDynamicSettings({ ...expectedDefaults, hiddenAudio }).hiddenAudio, hiddenAudio);
  }
});

test("rejects out-of-range volumes instead of silently clamping", () => {
  const { validateDynamicSettings } = requireSettings();

  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, masterVolume: 1.01 }),
    (error) => error?.code === "VALUE_RANGE" && /masterVolume/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, ambientVolume: -0.01 }),
    (error) => error?.code === "VALUE_RANGE" && /ambientVolume/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, uiVolume: Number.NaN }),
    (error) => error?.code === "VALUE_RANGE" && /uiVolume/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, visualOpacity: -0.01 }),
    (error) => error?.code === "VALUE_RANGE" && /visualOpacity/.test(error.message),
  );
});

test("rejects unknown keys, missing keys, invalid schema versions, and wrong types", () => {
  const { validateDynamicSettings } = requireSettings();

  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, autoplay: true }),
    (error) => error?.code === "UNKNOWN_FIELD" && /autoplay/.test(error.message),
  );
  const missing = { ...expectedDefaults };
  delete missing.soundEnabled;
  assert.throws(
    () => validateDynamicSettings(missing),
    (error) => error?.code === "MISSING_FIELD" && /soundEnabled/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, schemaVersion: 2 }),
    (error) => error?.code === "SCHEMA_VERSION" && /schemaVersion/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, soundEnabled: 1 }),
    (error) => error?.code === "VALUE_TYPE" && /soundEnabled/.test(error.message),
  );
  assert.throws(
    () => validateDynamicSettings({ ...expectedDefaults, backgroundPlayback: "yes" }),
    (error) => error?.code === "VALUE_TYPE" && /backgroundPlayback/.test(error.message),
  );
});

test("recovers malformed or invalid persisted JSON to safe defaults", () => {
  const { DEFAULT_DYNAMIC_SETTINGS, parseDynamicSettings } = requireSettings();

  assert.equal(parseDynamicSettings("{broken"), DEFAULT_DYNAMIC_SETTINGS);
  assert.deepEqual(
    parseDynamicSettings(JSON.stringify({ ...expectedDefaults, soundEnabled: "yes" })),
    expectedDefaults,
  );
  const parsed = parseDynamicSettings(JSON.stringify({ ...expectedDefaults, uiMuted: true }));
  assert.equal(parsed.uiMuted, true);
  assert.equal(Object.isFrozen(parsed), true);
});

test("migrates older partial settings field by field without erasing valid preferences", () => {
  const { parseDynamicSettings } = requireSettings();
  const parsed = parseDynamicSettings(JSON.stringify({
    schemaVersion: 1,
    backgroundPlayback: false,
    soundEnabled: true,
    masterVolume: 0.42,
    quality: "balanced",
  }));

  assert.deepEqual(parsed, {
    ...expectedDefaults,
    backgroundPlayback: false,
    soundEnabled: true,
    masterVolume: 0.42,
    quality: "balanced",
  });
  assert.equal(Object.isFrozen(parsed), true);
});

test("migrates malformed individual fields to defaults while preserving valid siblings", () => {
  const { parseDynamicSettings } = requireSettings();
  const parsed = parseDynamicSettings(JSON.stringify({
    schemaVersion: 1,
    backgroundPlayback: false,
    soundEnabled: "invalid",
    visualOpacity: 0.64,
    hiddenAudio: "continue",
    futureSetting: true,
  }));

  assert.equal(parsed.backgroundPlayback, false);
  assert.equal(parsed.soundEnabled, expectedDefaults.soundEnabled);
  assert.equal(parsed.visualOpacity, 0.64);
  assert.equal(parsed.hiddenAudio, "continue");
});

test("serializes validated settings in deterministic contract order", () => {
  const { serializeDynamicSettings } = requireSettings();
  const shuffled = {
    hiddenAudio: "pause",
    backgroundPlayback: true,
    uiMuted: false,
    schemaVersion: 1,
    quality: "auto",
    ambientMuted: false,
    uiVolume: 0.8,
    visualOpacity: 1,
    masterVolume: 1,
    reducedMotion: "system",
    soundEnabled: false,
    ambientVolume: 0.7,
  };

  assert.equal(
    serializeDynamicSettings(shuffled),
    `${JSON.stringify(expectedDefaults, null, 2)}\n`,
  );
});

test("atomically replaces a regular settings file and leaves no temporary file", async (t) => {
  const { serializeDynamicSettings, writeSettingsAtomically } = requireSettings();
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "settings.json");
  await fs.writeFile(destination, "old settings\n", { mode: 0o600 });
  const settings = { ...expectedDefaults, soundEnabled: true, ambientVolume: 0.25 };

  await writeSettingsAtomically(destination, settings);

  assert.equal(await fs.readFile(destination, "utf8"), serializeDynamicSettings(settings));
  assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  }
});

test("refuses a symlink destination without changing its target", async (t) => {
  const { writeSettingsAtomically } = requireSettings();
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "outside.json");
  const destination = path.join(directory, "settings.json");
  await fs.writeFile(target, "protected\n");
  try {
    await fs.symlink(target, destination, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("creating file symlinks requires Windows Developer Mode or elevation");
      return;
    }
    throw error;
  }

  await assert.rejects(
    writeSettingsAtomically(destination, expectedDefaults),
    (error) => error?.code === "DESTINATION_SYMLINK" && /symlink/.test(error.message),
  );
  assert.equal(await fs.readFile(target, "utf8"), "protected\n");
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
});

test("validation failure preserves the previous settings file", async (t) => {
  const { writeSettingsAtomically } = requireSettings();
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "settings.json");
  await fs.writeFile(destination, "last known good\n");

  await assert.rejects(
    writeSettingsAtomically(destination, { ...expectedDefaults, masterVolume: 3 }),
    (error) => error?.code === "VALUE_RANGE",
  );
  assert.equal(await fs.readFile(destination, "utf8"), "last known good\n");
  assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
});
