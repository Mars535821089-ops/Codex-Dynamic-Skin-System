import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mediaRoot = fileURLToPath(new URL("../fixtures/media/", import.meta.url));

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function mediaType(name) {
  const extension = path.extname(name).toLowerCase();
  return ({ ".json": "application/json", ".css": "text/css", ".mp4": "video/mp4",
    ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".js": "application/javascript" })[extension];
}

export async function makeV2Package(parent, name, options = {}) {
  const root = path.join(parent, name); await fs.mkdir(root);
  const paths = options.flat ? {
    video: "loop.mp4", poster: "poster.webp", ambient: "ambient.m4a", ui: "complete.wav",
  } : {
    video: "media/loop.mp4", poster: "media/poster.webp", ambient: "audio/ambient.m4a", ui: "audio/ui/complete.wav",
  };
  const theme = {
    schemaVersion: 2, id: "test.dynamic-skin", name: "Dynamic test", version: "1.0.0",
    capabilities: ["safe-css", "animated-background", "sound-pack"],
    visual: { kind: "video", asset: paths.video, poster: paths.poster, loop: true },
    audio: {
      ambient: { source: options.embedded ? "visual" : "asset", ...(options.embedded ? {} : { asset: paths.ambient }), loop: true, volume: 0.5, analyze: true },
      ui: { volume: 0.7, events: { taskCompleted: paths.ui } },
    },
    styles: "theme.css", tokens: { background: "#071116", text: "#e9fff1" },
  };
  options.mutateTheme?.(theme, paths);
  const files = new Map([
    ["theme.json", jsonBytes(theme)],
    ["theme.css", Buffer.from('[data-ds-part="root"] { color: var(--ds-theme-color-text); }\n')],
    [paths.video, await fs.readFile(path.join(mediaRoot, "loop-h264.mp4"))],
    [paths.poster, await fs.readFile(path.join(mediaRoot, "tiny.webp"))],
    [paths.ui, await fs.readFile(path.join(mediaRoot, "tone-pcm.wav"))],
  ]);
  if (!options.embedded) files.set(paths.ambient, await fs.readFile(path.join(mediaRoot, "tone-aac.m4a")));
  options.mutateFiles?.(files, paths);
  for (const [relativePath, bytes] of files) {
    const target = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const manifest = {
    packageVersion: 1, themeId: theme.id, version: theme.version, skinApiVersion: 2,
    minClientVersion: "1.3.0", platforms: ["macos", "windows"], capabilities: theme.capabilities,
    publisher: { id: "test-publisher", displayName: "Test Publisher" }, license: "MIT",
    provenance: { aiGenerated: false, summary: "Synthetic validation fixture." },
    files: [...files].map(([filePath, bytes]) => ({ path: filePath, mediaType: mediaType(filePath), bytes: bytes.length, sha256: sha256(bytes) })),
    createdAt: "2026-08-27T00:00:00Z",
  };
  options.mutateManifest?.(manifest, paths);
  await fs.writeFile(path.join(root, "manifest.json"), jsonBytes(manifest));
  if (options.undeclared) await fs.writeFile(path.join(root, "notes.txt"), "undeclared\n");
  return { root, theme, manifest, paths };
}
