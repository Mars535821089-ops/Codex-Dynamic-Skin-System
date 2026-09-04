import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readThemeSelection,
  themeSelectionPath,
  writeThemeSelection,
} from "../scripts/theme-selection-store.mjs";

test("Windows watcher persists and replaces native/theme display mode", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-selection-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const selectionFile = themeSelectionPath({ pauseFile: path.join(state, "paused") });

  await writeThemeSelection(selectionFile, "com.mars.space-roamer", "native");
  assert.deepEqual(await readThemeSelection(selectionFile), {
    schema: "codex-dream-skin-selected-theme/2",
    themeId: "com.mars.space-roamer",
    mode: "native",
  });
  await writeThemeSelection(selectionFile, "com.mars.space-roamer", "theme");
  assert.equal((await readThemeSelection(selectionFile)).mode, "theme");
});

test("Windows legacy selection migrates to injected display mode", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-selection-v1-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const selectionFile = path.join(state, "selected-theme.json");
  await fs.writeFile(selectionFile,
    '{"schema":"codex-dream-skin-selected-theme/1","themeId":"com.mars.space-roamer"}\n');
  assert.equal((await readThemeSelection(selectionFile)).mode, "theme");
});

test("Windows selection persistence rejects unsafe state", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-selection-safe-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const selectionFile = path.join(state, "selected-theme.json");
  const external = path.join(state, "external.json");
  await fs.writeFile(external,
    '{"schema":"codex-dream-skin-selected-theme/2","themeId":"com.mars.safe","mode":"theme"}\n');
  await fs.symlink(external, selectionFile);
  await assert.rejects(() => readThemeSelection(selectionFile), /symbolic link/i);
  await assert.rejects(() => writeThemeSelection(path.join(state, "other.json"), "../escape"),
    /theme id/i);
});

test("Windows watcher selection refuses acceptance fixtures unless isolated acceptance opts in", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-selection-acceptance-"));
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
