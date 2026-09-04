import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSelectedThemeDirectory } from "../../macos/scripts/resolve-selected-theme-directory.mjs";

async function writeTheme(directory, id, name = id) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "background.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await fs.writeFile(path.join(directory, "theme.json"), `${JSON.stringify({
    schemaVersion: 2,
    id,
    name,
    version: "1.0.0",
    capabilities: [],
    visual: { kind: "image", asset: "background.png", fit: "cover", opacity: 1 },
    audio: { ambient: { source: "none", loop: true, volume: 0, analyze: false }, ui: { volume: 0, events: {} } },
    tokens: {},
  })}\n`);
}

test("verification resolves a selected theme from a configured external library", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selected-dir-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const fallback = path.join(state, "theme");
  const external = path.join(state, "external-library");
  const selected = path.join(external, "selected");
  await writeTheme(fallback, "com.mars.fallback");
  await writeTheme(selected, "com.mars.selected");
  await fs.mkdir(path.join(state, "themes"));
  await fs.writeFile(path.join(state, "selected-theme.json"), `${JSON.stringify({
    schema: "codex-dream-skin-selected-theme/2", themeId: "com.mars.selected", mode: "theme",
  })}\n`);
  await fs.writeFile(path.join(state, "theme-storage.json"), `${JSON.stringify({
    schemaVersion: 1, libraryRoot: external,
  })}\n`);

  assert.equal(await resolveSelectedThemeDirectory({
    fallbackThemeDir: fallback,
    defaultThemeLibrary: path.join(state, "themes"),
    settingsPath: path.join(state, "dynamic-settings.json"),
  }), await fs.realpath(selected));
});

test("verification falls back safely when the stored selection is absent from the library", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selected-fallback-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const fallback = path.join(state, "theme");
  const library = path.join(state, "themes");
  await writeTheme(fallback, "com.mars.fallback");
  await fs.mkdir(library);
  await fs.writeFile(path.join(state, "selected-theme.json"), `${JSON.stringify({
    schema: "codex-dream-skin-selected-theme/2", themeId: "com.mars.missing", mode: "theme",
  })}\n`);

  assert.equal(await resolveSelectedThemeDirectory({
    fallbackThemeDir: fallback,
    defaultThemeLibrary: library,
    settingsPath: path.join(state, "dynamic-settings.json"),
  }), await fs.realpath(fallback));
});

test("verification ignores symlinked theme children", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selected-symlink-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const fallback = path.join(state, "theme");
  const library = path.join(state, "themes");
  const outside = path.join(state, "outside");
  await writeTheme(fallback, "com.mars.fallback");
  await writeTheme(outside, "com.mars.selected");
  await fs.mkdir(library);
  await fs.symlink(outside, path.join(library, "selected"));
  await fs.writeFile(path.join(state, "selected-theme.json"), `${JSON.stringify({
    schema: "codex-dream-skin-selected-theme/2", themeId: "com.mars.selected", mode: "theme",
  })}\n`);

  assert.equal(await resolveSelectedThemeDirectory({
    fallbackThemeDir: fallback,
    defaultThemeLibrary: library,
    settingsPath: path.join(state, "dynamic-settings.json"),
  }), await fs.realpath(fallback));
});
