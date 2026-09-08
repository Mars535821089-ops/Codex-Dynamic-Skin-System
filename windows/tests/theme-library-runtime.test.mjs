import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as injector from "../scripts/injector.mjs";
import { DEFAULT_DYNAMIC_SETTINGS, writeSettingsAtomically } from "../assets/dynamic/settings.mjs";
import { writeThemeSelection } from "../scripts/theme-selection-store.mjs";
import { runThemeRuntimeCommand } from "../scripts/theme-runtime-command.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function fixture(t, extension = "png") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-library-中文 空格-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const themeLibrary = path.join(root, "themes");
  const themeDir = path.join(themeLibrary, "local.test.first");
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, `image.${extension}`), extension === "gif"
    ? Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") : png);
  await fs.writeFile(path.join(themeDir, "theme.json"), JSON.stringify({ schemaVersion: 2,
    id: "local.test.first", name: "中文主题", version: "1.0.0", capabilities: [],
    visual: { kind: "image", asset: `image.${extension}`, fit: "cover", opacity: 1 },
    audio: { ambient: { source: "none", loop: true, volume: .7, analyze: false }, ui: { volume: .8, events: {} } }, tokens: {},
  }));
  return { root, themeLibrary, themeDir, settings: path.join(root, "dynamic-settings.json") };
}

test("Windows library payload exposes validated catalog and persistent settings", async (t) => {
  const options = await fixture(t);
  assert.equal(typeof injector.loadPayloadForOptions, "function");
  await writeSettingsAtomically(options.settings, { ...DEFAULT_DYNAMIC_SETTINGS, masterVolume: .17 });
  const loaded = await injector.loadPayloadForOptions(options);
  assert.deepEqual([...loaded.themeDirectories.keys()], ["local.test.first"]);
  assert.match(loaded.payload, /"settingsAuthority":"shared-file"/);
  assert.match(loaded.payload, /"masterVolume":0.17/);
  assert.match(loaded.payload, /"themeCatalog":\[\{"id":"local.test.first"/);
});

test("Windows GIF image themes retain animated media and load a safe shell poster", async (t) => {
  const options = await fixture(t, "gif");
  const loaded = await injector.loadPayload(options.themeDir);
  assert.equal(loaded.theme.visual.asset, "image.gif");
  assert.equal(loaded.sourceApiVersion, 2);
});

test("Windows runtime accepts library/settings arguments with non-ASCII spaces", () => {
  const parsed = injector.parseArgs(["--check-payload", "--theme-library", "中文 themes", "--settings", "中文 settings.json"]);
  assert.equal(parsed.themeLibrary, path.resolve("中文 themes"));
  assert.equal(parsed.settings, path.resolve("中文 settings.json"));
});

test("Windows restores a saved library selection and native mode instead of the fallback directory", async (t) => {
  const options = await fixture(t);
  const selectedDirectory = options.themeDir;
  const fallback = path.join(options.root, "active-theme");
  await fs.cp(selectedDirectory, fallback, { recursive: true });
  const metadata = JSON.parse(await fs.readFile(path.join(fallback, "theme.json"), "utf8"));
  metadata.id = "local.test.fallback";
  await fs.writeFile(path.join(fallback, "theme.json"), JSON.stringify(metadata));
  await writeThemeSelection(path.join(options.root, "selected-theme.json"), "local.test.first", "native");
  const loaded = await injector.loadPayloadForOptions({ ...options, themeDir: fallback, resolveSelection: true });
  assert.equal(loaded.theme.id, "local.test.first");
  assert.equal(loaded.displayMode, "native");
  assert.equal(loaded.themeDir, await fs.realpath(selectedDirectory));
});

test("legacy Windows installs receive a dynamic center and content-specific stable IDs", async (t) => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.themeDir, "theme.json"), JSON.stringify({ schemaVersion: 1,
    id: "preset-legacy", name: "Legacy", image: "image.png" }));
  const loaded = await injector.loadPayloadForOptions(options);
  assert.equal(loaded.sourceApiVersion, 2);
  assert.match(loaded.theme.id, /^local\.legacy\./);
  assert.match(loaded.payload, /"themeCatalog":/);
  const runtime = await runThemeRuntimeCommand(["select", options.themeDir, options.root]);
  assert.equal(runtime.RuntimeId, loaded.theme.id);
  const relocated = path.join(options.root, "moved 中文");
  await fs.cp(options.themeDir, relocated, { recursive: true });
  assert.equal((await runThemeRuntimeCommand(["inspect", relocated])).RuntimeId, loaded.theme.id);
  await fs.writeFile(path.join(relocated, "theme.json"), JSON.stringify({ schemaVersion: 1,
    id: "preset-legacy", name: "Changed", image: "image.png" }));
  assert.notEqual((await runThemeRuntimeCommand(["inspect", relocated])).RuntimeId, loaded.theme.id);
});
