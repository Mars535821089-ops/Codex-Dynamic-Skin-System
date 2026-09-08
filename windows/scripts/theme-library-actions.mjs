import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { inspectMediaFile } from "../assets/dynamic/media-signatures.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { buildContentManifest, writeContentManifest } from "../assets/dynamic/content-manifest.mjs";

const execFileAsync = promisify(execFile);
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export async function runWindowsPowerShell(script, { execute = execFileAsync, timeout = 10 * 60_000 } = {}) {
  if (execute === execFileAsync && process.platform !== "win32") {
    throw new Error("Windows native actions require Windows");
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  if (!path.win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is invalid");
  const executable = path.win32.join(systemRoot, process.arch === "ia32" && process.env.PROCESSOR_ARCHITEW6432
    ? "Sysnative" : "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);\n" + script;
  const { stdout } = await execute(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error("Windows native action returned invalid JSON"); }
  return result;
}

export function validateWindowsDialogSelection(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error("Windows native picker returned an invalid path");
  }
  return value;
}

async function trustedLibraryRoot(libraryRoot) {
  const requested = path.resolve(libraryRoot);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink()) throw new Error("Theme library root must not be a symbolic link");
  if (!stat.isDirectory()) throw new Error("Theme library root must be a directory");
  return fs.realpath(requested);
}

async function archiveRoot(libraryRoot, { create = false } = {}) {
  const root = path.join(libraryRoot, ".deleted");
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw new Error("Theme archive must not be a symbolic link or junction");
  if (!stat.isDirectory()) throw new Error("Theme archive must be a directory");
  const real = await fs.realpath(root);
  if (path.dirname(real) !== libraryRoot) throw new Error("Theme archive must stay inside the selected library");
  return real;
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
  const requested = path.resolve(sourcePath);
  const sourceStat = await fs.lstat(requested);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error("Imported media must be a regular file, not a symbolic link");
  const handle = await fs.open(requested, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== sourceStat.dev || before.ino !== sourceStat.ino
      || before.size !== sourceStat.size || before.size > 96 * 1024 * 1024) throw new Error("Imported media changed or exceeds the 96 MiB limit");
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
  const candidates = (process.env.PATH || "").split(path.delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter((directory) => directory && path.isAbsolute(directory))
    .map((directory) => path.join(directory, "ffmpeg.exe"));
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error(
    "Video import requires ffmpeg.exe on PATH for a validated poster and optional 720p/24fps optimization. Install FFmpeg, then import it again.",
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
  await execFileAsync(ffmpeg, args, { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
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

export async function createVideoPoster(videoPath, posterPath) {
  const ffmpeg = await findFfmpeg();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-poster-"));
  try {
    const generated = path.join(temp, "poster.png");
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", videoPath,
      "-frames:v", "1", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease", generated], {
      timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    await inspectMediaFile(generated, { role: "poster" });
    await fs.copyFile(generated, posterPath, fsConstants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function chooseMediaFile(options = {}) {
  const value = await runWindowsPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
try {
  $dialog.Title = 'Choose an image, video, GIF, or theme ZIP'
  $dialog.Filter = 'Supported themes|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.webm;*.zip|Images|*.png;*.jpg;*.jpeg;*.webp;*.gif|Videos|*.mp4;*.webm|Theme packages|*.zip'
  $dialog.Multiselect = $false
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -InputObject $dialog.FileName -Compress }
  else { 'null' }
} finally { $dialog.Dispose() }`, options);
  return validateWindowsDialogSelection(value);
}

export async function createThemeThumbnailDataUrl(themeDir, theme, options = {}) {
  const root = await trustedLibraryRoot(themeDir);
  const asset = theme?.visual?.kind === "video" ? theme.visual.poster : theme?.visual?.asset;
  if (!asset) return null;
  if (typeof asset !== "string" || path.isAbsolute(asset) || path.win32.isAbsolute(asset)
    || asset.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new Error("Theme thumbnail must be a relative path inside the theme");
  }
  const candidate = path.join(root, ...asset.split(/[\\/]/));
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Theme thumbnail must be a regular file");
  const source = await fs.realpath(candidate);
  const relative = path.relative(root, source);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Theme thumbnail must remain inside the theme");
  }
  const info = await inspectMediaFile(source, { role: "image" });
  if (info.container !== "gif" && info.sizeBytes <= 192 * 1024
    && Number(info.width) <= 320 && Number(info.height) <= 180) {
    return `data:${info.mime};base64,${(await readStableSource(source)).toString("base64")}`;
  }
  if (info.container === "webp") {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-thumbnail-"));
    try {
      const output = path.join(temp, "thumbnail.jpg");
      await execFileAsync(await findFfmpeg(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source,
        "-frames:v", "1", "-vf", "scale=240:135:force_original_aspect_ratio=decrease", output],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      await inspectMediaFile(output, { role: "image" });
      const bytes = await readStableSource(output);
      if (bytes.length > 192 * 1024) throw new Error("Generated thumbnail exceeds the size limit");
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const value = await runWindowsPowerShell(`
Add-Type -AssemblyName System.Drawing
$image = $null; $bitmap = $null; $graphics = $null; $stream = $null
try {
  $image = [System.Drawing.Image]::FromFile(${quote(source)})
  $scale = [Math]::Min(1.0, [Math]::Min(240.0 / $image.Width, 135.0 / $image.Height))
  $width = [Math]::Max(1, [int]($image.Width * $scale))
  $height = [Math]::Max(1, [int]($image.Height * $scale))
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Black)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($image, 0, 0, $width, $height)
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  ConvertTo-Json -InputObject ('data:image/jpeg;base64,' + [Convert]::ToBase64String($stream.ToArray())) -Compress
} finally {
  if ($stream) { $stream.Dispose() }; if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }; if ($image) { $image.Dispose() }
}`, { ...options, timeout: 30_000 });
  if (typeof value !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value)
    || value.length > 256 * 1024) throw new Error("Native thumbnail generation returned an invalid image");
  return value;
}

export async function importMediaTheme({
  libraryRoot,
  sourcePath,
  themeName,
  createPoster = createVideoPoster,
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
    const loaded = await loadInstalledSkin(finalDir, { platform: "windows", clientVersion: "2.0.0" });
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
    const loaded = await loadInstalledSkin(stage, { platform: "windows", clientVersion: "2.0.0" });
    if (loaded.sourceApiVersion !== 2 || loaded.theme.id !== themeId) throw new Error("Imported theme validation failed");
    const contentManifest = await buildContentManifest(stage, loaded.declaredFiles);
    await writeContentManifest(path.join(stage, "content-manifest.json"), contentManifest);
    const verified = await loadInstalledSkin(stage, { platform: "windows", clientVersion: "2.0.0" });
    if (verified.contentManifest?.versionId !== contentManifest.versionId) {
      throw new Error("Imported theme content manifest validation failed");
    }
    try {
      await fs.rename(stage, finalDir);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
      const concurrent = await loadInstalledSkin(finalDir, { platform: "windows", clientVersion: "2.0.0" });
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
  createPoster = createVideoPoster,
  stateRoot,
  importZip = importThemeZip,
  refreshPayload,
}) {
  if (typeof refreshPayload !== "function") {
    throw new TypeError("Media import activation requires refreshPayload");
  }
  const imported = path.extname(sourcePath).toLowerCase() === ".zip"
    ? await importZip({ libraryRoot, sourcePath, stateRoot })
    : await importMediaTheme({ libraryRoot, sourcePath, themeName, createPoster });
  await refreshPayload(
    imported.themeDir,
    imported.duplicate ? "media-import-existing" : "media-import",
  );
  return imported;
}

export async function importThemeZip({ libraryRoot, sourcePath, stateRoot, ...options }) {
  const root = await trustedLibraryRoot(libraryRoot);
  if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error("Theme ZIP import requires an absolute stateRoot");
  const source = path.resolve(sourcePath);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Theme ZIP must be a regular file, not a symbolic link");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const result = await runWindowsPowerShell(`
. ${quote(path.join(scripts, "common-windows.ps1"))}
. ${quote(path.join(scripts, "theme-windows.ps1"))}
$result = Import-DreamSkinThemeZip -ArchivePath ${quote(source)} -StateRoot ${quote(path.resolve(stateRoot))}
ConvertTo-Json -InputObject $result -Depth 8 -Compress`, { ...options, timeout: 10 * 60_000 });
  if (!result || !["Imported", "Duplicate"].includes(result.Status) || typeof result.Path !== "string") {
    throw new Error("Theme ZIP importer returned an invalid result");
  }
  const destinationStat = await fs.lstat(result.Path);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
    throw new Error("Imported theme must not be a symbolic link or junction");
  }
  const themeDir = await fs.realpath(result.Path);
  if (path.dirname(themeDir) !== root) throw new Error("Imported theme is outside the selected library");
  const loaded = await loadInstalledSkin(themeDir, { platform: "windows", clientVersion: "2.0.0" });
  return { themeId: loaded.theme.id, themeDir, duplicate: result.Status === "Duplicate",
    versionId: loaded.contentManifest?.versionId ?? null, cleanupWarning: result.CleanupWarning ?? null };
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
  const loaded = await loadInstalledSkin(realTheme, { platform: "windows", clientVersion: "2.0.0" });
  if (loaded.theme.id !== expectedThemeId) throw new Error("Theme identity changed before deletion");
  const deletedRoot = await archiveRoot(root, { create: true });
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
  const realDeletedRoot = await archiveRoot(root);
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
  const loaded = await loadInstalledSkin(realArchive, { platform: "windows", clientVersion: "2.0.0" });
  if (loaded.theme.id !== expectedThemeId) throw new Error("Archived theme identity changed before restore");
  await fs.rename(realArchive, destination);
  return { themeId: loaded.theme.id, themeDir: destination };
}
