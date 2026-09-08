import fs from "node:fs/promises";
import path from "node:path";
import { writeSettingsAtomically } from "../assets/dynamic/settings.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { chooseMediaFile, importMediaThemeAndActivate, archiveThemeDirectory,
  restoreArchivedThemeDirectory } from "./theme-library-actions.mjs";
import { chooseThemeLibraryDirectory, migrateThemeLibrary, finalizeThemeLibraryMigration,
  rollbackThemeLibraryMigration, writeThemeStoragePreference } from "./theme-storage-actions.mjs";

// This controller owns user-triggered filesystem transactions. Renderer commits
// are injected so a failed live apply can roll back before files are archived.
export function createThemeLibraryController({ getCurrent, getLibraryRoot, setLibraryRoot,
  refreshPayload, settings = null, storagePreference = null, stateRoot = null,
  chooseMedia = chooseMediaFile, chooseDirectory = chooseThemeLibraryDirectory,
  presentStatus = async () => {} }) {
  let sequence = 0;
  const select = async (id) => {
    const directory = getCurrent().themeDirectories?.get(id);
    if (!directory) throw new Error("Selected theme is unavailable");
    await refreshPayload(directory, "renderer-request", "theme");
  };
  const apply = async (request) => {
    const current = getCurrent();
    if (request.themeId !== current.theme.id || request.generation !== current.revision) return false;
    if (request.action === "save-settings") {
      if (!settings) throw new Error("Saving settings requires --settings");
      await writeSettingsAtomically(settings, request.settings);
      return true;
    }
    const token = `${process.pid}:${Date.now()}:${++sequence}`;
    const status = (state, message) => presentStatus(token, state, message);
    try {
      if (request.action === "restore-default-theme") {
        await status("loading", "正在还原原生 Codex…");
        await refreshPayload(current.themeDir, "restore-default-theme", "native");
        await status("success", "已还原默认主题");
      } else if (request.action === "import-media") {
        if (!getLibraryRoot()) throw new Error("Theme library is unavailable");
        await status("loading", "请选择图片、GIF、视频或主题包…");
        const sourcePath = await chooseMedia();
        if (!sourcePath) { await status("cancelled", "已取消添加主题"); return false; }
        await status("loading", "正在验证并添加主题…");
        await importMediaThemeAndActivate({ libraryRoot: getLibraryRoot(), stateRoot, sourcePath,
          refreshPayload: (directory, reason) => refreshPayload(directory, reason, "theme") });
        await status("success", `已添加并应用「${getCurrent().theme.name}」`);
      } else if (request.action === "delete-theme") {
        const libraryRoot = getLibraryRoot();
        const directory = current.themeDirectories?.get(request.targetThemeId);
        if (!libraryRoot || !directory) throw new Error("Selected theme is unavailable");
        if (current.themeDirectories.size <= 1) throw new Error("Cannot delete the only installed theme");
        // The bundled fallback lives outside the library and cannot be deleted.
        if (path.dirname(await fs.realpath(directory)) !== await fs.realpath(libraryRoot)) {
          throw new Error("The bundled default theme cannot be deleted");
        }
        const target = await loadInstalledSkin(directory, { platform: "windows", clientVersion: "2.0.0" });
        const fallback = [...current.themeDirectories].find(([id]) => id !== request.targetThemeId);
        await status("loading", "正在删除主题…");
        let archived = null;
        try {
          if (current.theme.id === request.targetThemeId) await refreshPayload(fallback[1], "delete-theme-fallback", "theme");
          archived = await archiveThemeDirectory({ libraryRoot, themeDir: directory, expectedThemeId: target.theme.id });
          await refreshPayload(getCurrent().themeDir, "delete-theme-catalog-refresh");
        } catch (error) {
          if (archived) await restoreArchivedThemeDirectory({ libraryRoot, archiveDir: archived.archiveDir,
            destinationDir: directory, expectedThemeId: target.theme.id });
          // Return both the visual state and catalog to their original state.
          await refreshPayload(current.themeDir, "delete-theme-rollback", current.displayMode ?? "theme");
          throw error;
        }
        await status("success", "已删除主题（可从素材库 .deleted 目录恢复）");
      } else if (request.action === "change-storage") {
        if (!storagePreference) throw new Error("Theme storage preference path is unavailable");
        await status("loading", "请选择新的主题素材库位置…");
        const selected = await chooseDirectory();
        if (!selected) { await status("cancelled", "已取消更改存储位置"); return false; }
        const destination = await fs.realpath(selected);
        const previousRoot = getLibraryRoot();
        if (previousRoot === destination) { await status("success", "主题素材库已在这个位置"); return true; }
        let migration = null;
        let committed = false;
        try {
          if (previousRoot) migration = await migrateThemeLibrary({ sourceRoot: previousRoot,
            destinationRoot: destination, removeSource: false });
          const themeDir = previousRoot && path.dirname(current.themeDir) === previousRoot
            ? path.join(destination, path.basename(current.themeDir)) : current.themeDir;
          setLibraryRoot(destination);
          await refreshPayload(themeDir, "storage-migration", current.displayMode ?? "theme");
          await writeThemeStoragePreference(storagePreference, destination);
          committed = true;
          if (migration) {
            try { await finalizeThemeLibraryMigration(migration); }
            catch (error) {
              await status("success", `素材库已切换；旧目录保留副本：${error.message}`);
              return true;
            }
          }
          await status("success", "主题素材库已迁移");
        } catch (error) {
          if (!committed) {
            setLibraryRoot(previousRoot);
            // Never delete staged assets until the previous renderer is restored.
            await refreshPayload(current.themeDir, "storage-migration-rollback", current.displayMode ?? "theme");
            if (migration) await rollbackThemeLibraryMigration(migration);
          }
          throw error;
        }
      } else throw new Error("Unsupported theme action");
      return true;
    } catch (error) {
      await status("error", `操作失败：${error.message}`);
      throw error;
    }
  };
  return { apply, select };
}
