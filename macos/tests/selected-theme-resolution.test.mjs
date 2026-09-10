import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isTransientThemeLibraryError,
  resolveSelectedThemeDirectory,
} from "../scripts/resolve-selected-theme-directory.mjs";

test("permission-denied external theme storage falls back to the staged validated theme", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "selected-theme-resolution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fallback = path.join(root, "fallback");
  const external = path.join(root, "external");
  await fs.mkdir(fallback);
  await fs.mkdir(external);
  await fs.writeFile(path.join(root, "selected-theme.json"), JSON.stringify({
    schema: "codex-dream-skin-selected-theme/2",
    themeId: "com.example.external",
    mode: "theme",
  }));
  await fs.writeFile(path.join(root, "theme-storage.json"), JSON.stringify({
    schemaVersion: 1,
    libraryRoot: external,
  }));
  await fs.chmod(external, 0o000);
  const resolved = await resolveSelectedThemeDirectory({
    fallbackThemeDir: fallback,
    defaultThemeLibrary: path.join(root, "themes"),
    settingsPath: path.join(root, "dynamic-settings.json"),
  });
  assert.equal(resolved, await fs.realpath(fallback));
});

test("only transient filesystem availability errors are eligible for fallback", () => {
  for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ESTALE", "EIO"]) {
    assert.equal(isTransientThemeLibraryError({ code }), true);
  }
  assert.equal(isTransientThemeLibraryError(new Error("invalid theme")), false);
});
