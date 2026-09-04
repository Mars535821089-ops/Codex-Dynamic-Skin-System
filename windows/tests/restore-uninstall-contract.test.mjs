import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows uninstall leaves its own directory before removing the installed engine", async () => {
  const source = await fs.readFile(
    path.join(windowsRoot, "scripts", "restore-dream-skin.ps1"),
    "utf8",
  );
  const uninstallBlock = source.indexOf("if ($Uninstall)");
  const leaveEngine = source.indexOf("Set-Location -LiteralPath $StateRoot", uninstallBlock);
  const removeEngine = source.indexOf(
    "Remove-DreamSkinRuntimeTree -Path $engine.Root -StateRoot $StateRoot",
    uninstallBlock,
  );

  assert.ok(uninstallBlock >= 0, "restore must have an uninstall branch");
  assert.ok(leaveEngine > uninstallBlock, "uninstall must leave the installed engine directory");
  assert.ok(removeEngine > leaveEngine, "uninstall must remove the validated engine after leaving it");
});
