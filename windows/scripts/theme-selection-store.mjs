import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA = "codex-dream-skin-selected-theme/2";
const LEGACY_SCHEMA = "codex-dream-skin-selected-theme/1";
const MODES = new Set(["theme", "native"]);
const THEME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ACCEPTANCE_THEME_ID = /^acceptance\./i;
const MAX_SELECTION_BYTES = 1024;

export function themeSelectionPath({ pauseFile = null, themeDir = null } = {}) {
  const anchor = pauseFile || themeDir;
  return anchor ? path.join(path.dirname(path.resolve(anchor)), "selected-theme.json") : null;
}

export async function readThemeSelection(selectionFile) {
  if (!selectionFile) return null;
  let stat;
  try { stat = await fs.lstat(selectionFile); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("Theme selection file must not be a symbolic link");
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_SELECTION_BYTES) return null;
  try {
    const value = JSON.parse(await fs.readFile(selectionFile, "utf8"));
    if (![SCHEMA, LEGACY_SCHEMA].includes(value?.schema)
      || !THEME_ID.test(value?.themeId ?? "")) return null;
    const mode = value.schema === LEGACY_SCHEMA ? "theme" : value.mode;
    if (!MODES.has(mode)) return null;
    return { schema: SCHEMA, themeId: value.themeId, mode };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeThemeSelection(selectionFile, themeId, mode = "theme", {
  allowAcceptanceThemePersistence = false,
} = {}) {
  if (!selectionFile) throw new Error("Theme selection path is required");
  if (!THEME_ID.test(themeId ?? "")) throw new Error("Theme id is invalid");
  if (ACCEPTANCE_THEME_ID.test(themeId) && !allowAcceptanceThemePersistence) {
    throw new Error("Acceptance fixture themes require explicit isolated-acceptance persistence opt-in");
  }
  if (!MODES.has(mode)) throw new Error("Theme selection mode is invalid");
  const parent = path.dirname(path.resolve(selectionFile));
  await fs.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.selected-theme.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify({ schema: SCHEMA, themeId, mode }, null, 2)}\n`;
  try {
    await fs.writeFile(temporary, payload, { flag: "wx" });
    await fs.rename(temporary, path.resolve(selectionFile));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { schema: SCHEMA, themeId, mode };
}
