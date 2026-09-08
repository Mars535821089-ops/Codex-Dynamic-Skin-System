import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { normalizeLegacySkinIdentity } from "./injector.mjs";
import { writeThemeSelection } from "./theme-selection-store.mjs";

export async function runThemeRuntimeCommand([command, directory, stateRoot]) {
  if (!["inspect", "select"].includes(command) || !directory) throw new Error("Expected inspect/select and a theme directory");
  const loaded = await loadInstalledSkin(directory, { platform: "windows", clientVersion: "2.0.0" });
  const normalized = normalizeLegacySkinIdentity(loaded);
  if (command === "select") {
    if (!stateRoot) throw new Error("Selecting a theme requires a state root");
    await writeThemeSelection(path.join(stateRoot, "selected-theme.json"), normalized.theme.id, "theme");
  }
  return { Directory: path.resolve(directory), ThemePath: path.join(path.resolve(directory), "theme.json"),
    Theme: loaded.theme, RuntimeId: normalized.theme.id, SourceApiVersion: loaded.sourceApiVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runThemeRuntimeCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
