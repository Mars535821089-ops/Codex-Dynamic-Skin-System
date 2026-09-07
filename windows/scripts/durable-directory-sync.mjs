import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP"]);

export function isUnsupportedDirectorySyncError(error, platform = process.platform) {
  return platform === "win32"
    && error?.syscall === "fsync"
    && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code);
}

export async function syncDirectory(directory, options = {}) {
  const platform = options.platform ?? process.platform;
  const openDirectory = options.openDirectory
    ?? ((target) => fs.open(target, fsConstants.O_RDONLY));
  const handle = await openDirectory(directory);
  try {
    try {
      await handle.sync();
    } catch (error) {
      // Windows does not support fsync on directory handles. The files inside
      // are still individually fsynced; ignore only that platform limitation.
      if (!isUnsupportedDirectorySyncError(error, platform)) throw error;
    }
  } finally {
    await handle.close();
  }
}
