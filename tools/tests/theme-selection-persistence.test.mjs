import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readThemeSelection,
  resolveInitialThemeDirectory,
  themeSelectionPath,
  writeThemeSelection,
} from "../../macos/scripts/theme-selection-store.mjs";

test("watcher restores the last committed library theme instead of the fallback snapshot", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const library = path.join(state, "themes");
  const fallback = path.join(state, "theme");
  const selected = path.join(library, "com.mars.floating-in-space");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(fallback);
  const selectionFile = themeSelectionPath({
    settingsPath: path.join(state, "dynamic-settings.json"),
    themeLibrary: library,
  });

  await writeThemeSelection(selectionFile, "com.mars.floating-in-space", "native");
  assert.deepEqual(await readThemeSelection(selectionFile), {
    schema: "codex-dream-skin-selected-theme/2",
    themeId: "com.mars.floating-in-space",
    mode: "native",
  });
  assert.equal(await resolveInitialThemeDirectory({
    fallbackThemeDir: fallback,
    selectionFile,
    themeDirectories: new Map([["com.mars.floating-in-space", selected]]),
  }), await fs.realpath(selected));
});

test("legacy theme selection state remains compatible and defaults to injected mode", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection-v1-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const selectionFile = path.join(state, "selected-theme.json");
  await fs.writeFile(selectionFile, '{"schema":"codex-dream-skin-selected-theme/1","themeId":"com.mars.space-roamer"}\n');
  assert.deepEqual(await readThemeSelection(selectionFile), {
    schema: "codex-dream-skin-selected-theme/2",
    themeId: "com.mars.space-roamer",
    mode: "theme",
  });
});

test("invalid, missing, and symlinked selection state fails closed to the active snapshot", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection-invalid-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const fallback = path.join(state, "theme");
  await fs.mkdir(fallback);
  const selectionFile = path.join(state, "selected-theme.json");
  await fs.writeFile(selectionFile, '{"schema":"wrong","themeId":"../escape"}\n');
  assert.equal(await resolveInitialThemeDirectory({
    fallbackThemeDir: fallback,
    selectionFile,
    themeDirectories: new Map(),
  }), await fs.realpath(fallback));

  await fs.rm(selectionFile);
  const external = path.join(state, "external.json");
  await fs.writeFile(external, '{"schema":"codex-dream-skin-selected-theme/1","themeId":"safe"}\n');
  await fs.symlink(external, selectionFile);
  await assert.rejects(() => readThemeSelection(selectionFile), /symbolic link/i);
});

test("theme selection writes reject untrusted ids", async () => {
  await assert.rejects(() => writeThemeSelection("/tmp/not-used.json", "../escape"), /theme id/i);
  await assert.rejects(() => writeThemeSelection("/tmp/not-used.json", "com.mars.safe", "unknown"), /mode/i);
});

test("watcher selection refuses acceptance fixtures unless isolated acceptance explicitly opts in", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-selection-acceptance-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const selectionFile = path.join(state, "selected-theme.json");
  const original = '{"schema":"codex-dream-skin-selected-theme/2","themeId":"com.mars.safe","mode":"theme"}\n';
  await fs.writeFile(selectionFile, original);

  await assert.rejects(
    () => writeThemeSelection(selectionFile, "acceptance.video-gold"),
    /acceptance fixture/i,
  );
  assert.equal(await fs.readFile(selectionFile, "utf8"), original);

  await writeThemeSelection(selectionFile, "acceptance.video-gold", "theme", {
    allowAcceptanceThemePersistence: true,
  });
  assert.equal((await readThemeSelection(selectionFile)).themeId, "acceptance.video-gold");
});
