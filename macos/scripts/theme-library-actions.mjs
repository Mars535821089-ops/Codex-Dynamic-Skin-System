import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { inspectMediaFile } from "../assets/dynamic/media-signatures.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { buildContentManifest, writeContentManifest } from "../assets/dynamic/content-manifest.mjs";

const execFileAsync = promisify(execFile);
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

async function trustedLibraryRoot(libraryRoot) {
  const requested = path.resolve(libraryRoot);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink()) throw new Error("Theme library root must not be a symbolic link");
  if (!stat.isDirectory()) throw new Error("Theme library root must be a directory");
  return fs.realpath(requested);
}

function cleanThemeName(value, sourcePath) {
  const fallback = path.basename(sourcePath, path.extname(sourcePath));
  const cleaned = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/\0-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "Imported theme";
}

async function readStableSource(sourcePath) {
  const handle = await fs.open(path.resolve(sourcePath), fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Imported media must be a regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Imported media changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function extensionFor(info) {
  return ({ jpeg: ".jpg", png: ".png", webp: ".webp", gif: ".gif", mp4: ".mp4", webm: ".webm" })[info.container];
}

export function shouldNormalizeImportedVideo(info) {
  if (info?.family !== "video") return false;
  const width = Number(info.width) || 0;
  const height = Number(info.height) || 0;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const fps = Number(info.fps) || 0;
  return longEdge > 1280 || shortEdge > 720 || fps > 24.5;
}

function normalizedVideoDimensions(info) {
  const width = Math.max(2, Number(info.width) || 1280);
  const height = Math.max(2, Number(info.height) || 720);
  const scale = Math.min(1, 1280 / Math.max(width, height), 720 / Math.min(width, height));
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

async function findFfmpeg() {
  const candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  for (const candidate of candidates) {
    if (await fs.access(candidate, fsConstants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(
    "This video exceeds 1280x720 or 24fps. Install ffmpeg, then import it again.",
  );
}

export async function optimizeImportedVideo(sourcePath, outputPath, info) {
  const ffmpeg = await findFfmpeg();
  const target = normalizedVideoDimensions(info);
  const filters = [`scale=${target.width}:${target.height}`];
  if ((Number(info?.fps) || 0) > 24.5) filters.push("fps=24");
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-map", "0:v:0", "-map", "0:a?", "-vf", filters.join(","),
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  if (info?.hasAudio) args.push("-c:a", "aac", "-b:a", "160k");
  else args.push("-an");
  args.push(outputPath);
  await execFileAsync(ffmpeg, args, { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
}

function themeDefinition({ id, name, info, visualAsset }) {
  const visual = info.family === "video" ? {
    kind: "video", asset: visualAsset, poster: "media/poster.png",
    fit: "adaptive", opacity: 1, overscan: 1.08, loop: true,
  } : { kind: "image", asset: visualAsset, fit: "adaptive", opacity: 1 };
  const ambient = info.family === "video" && info.hasAudio
    ? { source: "visual", loop: true, volume: 0.7, analyze: true }
    : { source: "none" };
  return {
    schemaVersion: 2,
    id,
    name,
    version: "1.0.0",
    capabilities: info.family === "video"
      ? ["animated-background", ...(info.hasAudio ? ["sound-pack"] : [])]
      : [],
    visual,
    audio: { ambient, ui: { volume: 0.8, events: {} } },
    tokens: {},
  };
}

export async function createQuickLookPoster(videoPath, posterPath) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-poster-"));
  try {
    await execFileAsync("/usr/bin/qlmanage", ["-t", "-s", "1920", "-o", temp, videoPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const png = (await fs.readdir(temp)).find((name) => name.toLowerCase().endsWith(".png"));
    if (!png) throw new Error("macOS could not generate a poster for this video");
    await fs.copyFile(path.join(temp, png), posterPath, fsConstants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function chooseMediaFile() {
  const script = [
    "with timeout of 600 seconds",
    "tell application \"Finder\"",
    "activate",
    "set selectedFile to choose file with prompt \"选择要生成主题的图片或视频\"",
    "end tell",
    "end timeout",
    "return POSIX path of selectedFile",
  ];
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), {
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    const selected = stdout.trim();
    return selected || null;
  } catch (error) {
    if (error?.code === 1 || /User canceled/i.test(error?.stderr ?? "")) return null;
    throw error;
  }
}

export async function importMediaTheme({
  libraryRoot,
  sourcePath,
  themeName,
  createPoster = createQuickLookPoster,
  inspectMedia = inspectMediaFile,
  optimizeVideo = optimizeImportedVideo,
}) {
  const root = await trustedLibraryRoot(libraryRoot);
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  const requestedRole = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(sourceExtension)
    ? "image" : [".mp4", ".webm"].includes(sourceExtension) ? "video" : null;
  if (!requestedRole) throw new Error(`Unsupported imported media extension ${sourceExtension || "<none>"}`);
  const info = await inspectMedia(sourcePath, { role: requestedRole });
  if (!new Set(["image", "video"]).has(info.family)) throw new Error("Imported media must be an image or video");
  const extension = extensionFor(info);
  if (!extension) throw new Error(`Unsupported imported media container ${info.container}`);
  const bytes = await readStableSource(sourcePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const themeId = `com.mars.local.media-${digest.slice(0, 16)}`;
  const directoryName = `media-${digest.slice(0, 16)}`;
  const finalDir = path.join(root, directoryName);
  const existing = await fs.lstat(finalDir).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    const loaded = await loadInstalledSkin(finalDir, { platform: "macos", clientVersion: "2.0.0" });
    if (loaded.theme.id !== themeId) throw new Error("Imported theme destination already exists with another identity");
    return { themeId, themeDir: finalDir, duplicate: true, media: info };
  }
  const stage = path.join(root, `.import-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(path.join(stage, "media"), { recursive: true, mode: 0o700 });
    let finalInfo = info;
    let optimized = false;
    let visualExtension = extension;
    let stagedVisualPath;
    if (shouldNormalizeImportedVideo(info)) {
      const stagedSourcePath = path.join(stage, "media", `source${extension}`);
      stagedVisualPath = path.join(stage, "media", "visual.mp4");
      await fs.writeFile(stagedSourcePath, bytes, { flag: "wx", mode: 0o600 });
      await optimizeVideo(stagedSourcePath, stagedVisualPath, info);
      finalInfo = await inspectMedia(stagedVisualPath, { role: "video" });
      if (finalInfo.family !== "video" || finalInfo.container !== "mp4"
        || shouldNormalizeImportedVideo(finalInfo)) {
        throw new Error("Optimized video still exceeds the 1280x720/24fps playback limit");
      }
      await fs.rm(stagedSourcePath, { force: true });
      visualExtension = ".mp4";
      optimized = true;
    } else {
      stagedVisualPath = path.join(stage, "media", `visual${extension}`);
      await fs.writeFile(stagedVisualPath, bytes, { flag: "wx", mode: 0o600 });
    }
    const visualAsset = `media/visual${visualExtension}`;
    if (finalInfo.family === "video") {
      const posterPath = path.join(stage, "media", "poster.png");
      await createPoster(stagedVisualPath, posterPath);
      await inspectMedia(posterPath, { role: "poster" });
    }
    const theme = themeDefinition({ id: themeId, name: cleanThemeName(themeName, sourcePath),
      info: finalInfo, visualAsset });
    await fs.writeFile(path.join(stage, "theme.json"), `${JSON.stringify(theme, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const loaded = await loadInstalledSkin(stage, { platform: "macos", clientVersion: "2.0.0" });
    if (loaded.sourceApiVersion !== 2 || loaded.theme.id !== themeId) throw new Error("Imported theme validation failed");
    const contentManifest = await buildContentManifest(stage, loaded.declaredFiles);
    await writeContentManifest(path.join(stage, "content-manifest.json"), contentManifest);
    const verified = await loadInstalledSkin(stage, { platform: "macos", clientVersion: "2.0.0" });
    if (verified.contentManifest?.versionId !== contentManifest.versionId) {
      throw new Error("Imported theme content manifest validation failed");
    }
    try {
      await fs.rename(stage, finalDir);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
      const concurrent = await loadInstalledSkin(finalDir, { platform: "macos", clientVersion: "2.0.0" });
      if (concurrent.theme.id !== themeId) {
        throw new Error("Imported theme destination already exists with another identity");
      }
      await fs.rm(stage, { recursive: true, force: true });
      return { themeId, themeDir: finalDir, duplicate: true, media: info };
    }
    return { themeId, themeDir: finalDir, duplicate: false, media: finalInfo, optimized,
      versionId: contentManifest.versionId };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function importMediaThemeAndActivate({
  libraryRoot,
  sourcePath,
  themeName,
  createPoster = createQuickLookPoster,
  refreshPayload,
}) {
  if (typeof refreshPayload !== "function") {
    throw new TypeError("Media import activation requires refreshPayload");
  }
  const imported = await importMediaTheme({ libraryRoot, sourcePath, themeName, createPoster });
  await refreshPayload(
    imported.themeDir,
    imported.duplicate ? "media-import-existing" : "media-import",
  );
  return imported;
}

export async function archiveThemeDirectory({
  libraryRoot,
  themeDir,
  expectedThemeId,
  timestamp = Date.now(),
}) {
  const root = await trustedLibraryRoot(libraryRoot);
  const requested = path.resolve(themeDir);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink()) throw new Error("Theme directory must not be a symbolic link");
  const realTheme = await fs.realpath(requested);
  if (!stat.isDirectory() || path.dirname(realTheme) !== root) {
    throw new Error("Theme directory must be a direct child of the selected library");
  }
  const loaded = await loadInstalledSkin(realTheme, { platform: "macos", clientVersion: "2.0.0" });
  if (loaded.theme.id !== expectedThemeId) throw new Error("Theme identity changed before deletion");
  const deletedRoot = path.join(root, ".deleted");
  await fs.mkdir(deletedRoot, { recursive: true, mode: 0o700 });
  const archiveDir = path.join(deletedRoot,
    `${path.basename(realTheme)}-${Math.trunc(timestamp)}-${randomBytes(4).toString("hex")}`);
  await fs.rename(realTheme, archiveDir);
  return { themeId: loaded.theme.id, archiveDir };
}

export async function restoreArchivedThemeDirectory({
  libraryRoot,
  archiveDir,
  destinationDir,
  expectedThemeId,
}) {
  const root = await trustedLibraryRoot(libraryRoot);
  const deletedRoot = path.join(root, ".deleted");
  const realDeletedRoot = await fs.realpath(deletedRoot);
  const requestedArchive = path.resolve(archiveDir);
  const archiveStat = await fs.lstat(requestedArchive);
  if (archiveStat.isSymbolicLink()) throw new Error("Archived theme must not be a symbolic link");
  const realArchive = await fs.realpath(requestedArchive);
  if (!archiveStat.isDirectory() || path.dirname(realArchive) !== realDeletedRoot) {
    throw new Error("Archived theme must be a direct child of the library archive");
  }
  const destination = path.resolve(destinationDir);
  if (path.dirname(destination) !== root) {
    throw new Error("Restored theme must be a direct child of the selected library");
  }
  const existing = await fs.lstat(destination).catch((error) =>
    error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) throw new Error("Theme restore destination already exists");
  const loaded = await loadInstalledSkin(realArchive, { platform: "macos", clientVersion: "2.0.0" });
  if (loaded.theme.id !== expectedThemeId) throw new Error("Archived theme identity changed before restore");
  await fs.rename(realArchive, destination);
  return { themeId: loaded.theme.id, themeDir: destination };
}
