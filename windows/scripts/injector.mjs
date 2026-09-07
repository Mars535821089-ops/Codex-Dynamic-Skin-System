import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readImageMetadata } from "./image-metadata.mjs";
import {
  normalizeThemeColor,
  normalizeThemeText,
} from "../assets/theme-package-validator.mjs";
import { decodeAndValidateSafeCss } from "../assets/safe-css-validator.mjs";
import { collectThemeAssetPaths } from "../assets/dynamic/theme-contract.mjs";
import { createAssetHost } from "../assets/dynamic/asset-host.mjs";
import { loadInstalledSkin } from "../assets/dynamic/theme-loader.mjs";
import { DEFAULT_DYNAMIC_SETTINGS } from "../assets/dynamic/settings.mjs";
import { composeDynamicPayload } from "../assets/dynamic/payload-composer.mjs";
import { loadVersionedDynamicModuleBundle } from "../assets/dynamic/module-bundle-loader.mjs";
import { createRendererRecoveryQueue } from "./renderer-recovery-queue.mjs";
import { acquireWatcherLease } from "./watcher-lease.mjs";
import {
  selectLatestThemeActionRequest,
  validateThemeActionRequest,
} from "./theme-action-request.mjs";
import { selectLatestThemeRequest, validateThemeRequest } from "./theme-request.mjs";
import {
  readThemeSelection,
  themeSelectionPath,
  writeThemeSelection,
} from "./theme-selection-store.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const here = path.dirname(scriptPath);
const root = path.resolve(here, "..");
const SELECTOR_CONTRACT = JSON.parse(await fs.readFile(
  path.join(root, "assets", "selectors.json"), "utf8",
));
if (SELECTOR_CONTRACT.schema !== "codex-dream-skin-selectors/1" ||
  !Array.isArray(SELECTOR_CONTRACT.selectors)) {
  throw new Error("assets/selectors.json has an unsupported schema");
}
const SELECTOR_MAP = new Map();
for (const entry of SELECTOR_CONTRACT.selectors) {
  if (!entry?.key || !entry.selector || SELECTOR_MAP.has(entry.key)) {
    throw new Error(`assets/selectors.json has an invalid selector key: ${entry?.key || "<missing>"}`);
  }
  SELECTOR_MAP.set(entry.key, entry.selector);
}
const selectorFor = (key) => {
  const selector = SELECTOR_MAP.get(key);
  if (!selector) throw new Error(`Selector contract is missing ${key}`);
  return selector;
};
const selectorLiteral = (key) => JSON.stringify(selectorFor(key));
const stableTestidLiteral = (testid) => {
  if (!SELECTOR_CONTRACT.stableTestids?.includes(testid)) {
    throw new Error(`Selector contract is missing stable testid ${testid}`);
  }
  return JSON.stringify(`[data-testid="${testid}"]`);
};
const SKIN_VERSION = "1.5.17";
// .github/workflows/ci.yml's version-consistency check greps this file for a
// literal `const SKIN_VERSION = "...";` line, so the export stays a separate
// statement rather than an inline `export const`.
export { SKIN_VERSION };
export function appendDynamicModuleRevision(revisionHash, modules) {
  return revisionHash.update(JSON.stringify(
    modules.map(({ name, sha256 }) => ({ name, sha256 })),
  ));
}
const MAX_ART_BYTES = 10 * 1024 * 1024;
const MAX_SAFE_CSS_BYTES = 256 * 1024;
const DYNAMIC_MIME = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".css": "text/css",
});
const STRONG_THEME_AUDIT_MS = 30000;
const MIN_RENDERER_VIEWPORT_WIDTH = 320;
const MIN_RENDERER_VIEWPORT_HEIGHT = 240;
const VISIBLE_WINDOW_STATES = new Set(["normal", "maximized", "fullscreen"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const BROWSER_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const OPERATION_UI_HOST_ID = "chatgpt-dream-skin-operation";
const OPERATION_UI_REGISTRY_KEY = "__CHATGPT_DREAM_SKIN_OPERATION_UI__";
const OPERATION_KINDS = new Set(["apply", "pause", "switch"]);
const OPERATION_UI_STATES = new Set(["success", "error", "cancelled"]);
// Shared with macOS: in-renderer progress for pause/apply so both platforms feel the same.
const OPERATION_UI_CSS = `
  :host {
    all: initial;
    position: fixed;
    top: var(--dream-skin-operation-top, 0px);
    left: var(--dream-skin-operation-left, 0px);
    width: var(--dream-skin-operation-width, 100vw);
    height: var(--dream-skin-operation-height, 100vh);
    z-index: 2147483647;
    pointer-events: none;
    opacity: 0;
    display: grid;
    place-items: center;
    transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
  }
  :host([data-visible="true"]) { opacity: 1; }
  .status {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: min(220px, calc(100% - 32px));
    min-height: 112px;
    padding: 18px 20px;
    border: 1px solid rgba(238, 239, 244, 0.16);
    border-radius: 8px;
    background: rgba(32, 33, 38, 0.94);
    color: #f3f3f6;
    box-shadow: 0 8px 24px rgba(12, 14, 19, 0.22);
    font-size: 13px;
    font-weight: 550;
    line-height: 1.35;
    text-align: center;
    transform: translateY(-4px) scale(0.98);
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  :host([data-visible="true"]) .status { transform: translateY(0) scale(1); }
  :host([data-tone="light"]) .status {
    border-color: #d9dbe3;
    background: rgba(248, 248, 251, 0.96);
    color: #25262c;
    box-shadow: 0 8px 24px rgba(31, 35, 48, 0.14);
  }
  .indicator {
    box-sizing: border-box;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    color: #78a8f5;
  }
  :host([data-state="loading"]) .indicator {
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: dream-skin-operation-spin 720ms linear infinite;
  }
  :host([data-state="success"]) .indicator,
  :host([data-state="error"]) .indicator,
  :host([data-state="cancelled"]) .indicator {
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 16px;
    font-weight: 750;
  }
  :host([data-state="success"]) .indicator { color: #53b77b; }
  :host([data-state="success"]) .indicator::before { content: "✓"; }
  :host([data-state="error"]) .indicator { color: #e26d7e; }
  :host([data-state="error"]) .indicator::before { content: "!"; }
  :host([data-state="cancelled"]) .indicator { color: #a5a7b0; }
  :host([data-state="cancelled"]) .indicator::before { content: "×"; }
  .message { min-width: 0; overflow-wrap: anywhere; }
  @keyframes dream-skin-operation-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    :host, .status { transition: none; }
    :host([data-state="loading"]) .indicator {
      animation: none;
      border-top-color: currentColor;
      opacity: 0.65;
    }
  }
`;
let operationSequence = 0;

class CdpIdentityMismatchError extends Error {}

export function parseArgs(argv) {
  const options = {
    port: 9335,
    mode: "watch",
    timeoutMs: 30000,
    screenshot: null,
    reload: false,
    browserId: null,
    themeDir: path.join(root, "assets"),
    pauseFile: null,
    operationKind: null,
    operationUiState: null,
    operationMessage: null,
    operationToken: null,
    backgroundPlaybackCapable: false,
    allowAcceptanceThemePersistence: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--once") options.mode = "once";
    else if (arg === "--watch") options.mode = "watch";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--remove") options.mode = "remove";
    else if (arg === "--begin-operation") options.mode = "begin-operation";
    else if (arg === "--finish-operation") options.mode = "finish-operation";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--browser-id") options.browserId = argv[++i];
    else if (arg === "--theme-dir") options.themeDir = path.resolve(argv[++i]);
    else if (arg === "--pause-file") options.pauseFile = path.resolve(argv[++i]);
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++i]);
    else if (arg === "--operation-kind") options.operationKind = argv[++i];
    else if (arg === "--operation-ui-state") options.operationUiState = argv[++i];
    else if (arg === "--operation-message") options.operationMessage = argv[++i];
    else if (arg === "--operation-token") options.operationToken = argv[++i];
    else if (arg === "--background-playback-capable") options.backgroundPlaybackCapable = true;
    else if (arg === "--allow-acceptance-theme-persistence") options.allowAcceptanceThemePersistence = true;
    else if (arg === "--reload") options.reload = true;
    else if (arg === "--self-test") options.mode = "self-test";
    else if (arg === "--check-payload") options.mode = "check-payload";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 120000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }
  if (options.allowAcceptanceThemePersistence && options.mode !== "watch") {
    throw new Error("--allow-acceptance-theme-persistence is only valid in watch mode");
  }
  if (options.browserId !== null && !BROWSER_ID_PATTERN.test(options.browserId)) {
    throw new Error(`Invalid browser ID: ${options.browserId}`);
  }
  if (options.operationToken !== null && !/^\d{1,12}:\d{13}:\d{1,8}$/.test(options.operationToken)) {
    throw new Error("Invalid operation token");
  }
  if (options.mode === "begin-operation") {
    if (!OPERATION_KINDS.has(options.operationKind)) {
      throw new Error("Begin operation requires --operation-kind apply, pause, or switch");
    }
    if (!options.browserId) throw new Error("--browser-id is required in begin-operation mode");
  }
  if (options.mode === "finish-operation") {
    if (!OPERATION_UI_STATES.has(options.operationUiState)) {
      throw new Error("Finish operation requires --operation-ui-state success, error, or cancelled");
    }
    if (!options.operationToken) throw new Error("Finish operation requires --operation-token");
    if (typeof options.operationMessage !== "string" || options.operationMessage.length > 240
      || /[\r\n]/.test(options.operationMessage)) {
      throw new Error("Finish operation requires a single-line --operation-message up to 240 characters");
    }
    if (!options.browserId) throw new Error("--browser-id is required in finish-operation mode");
  }
  if (["watch", "once", "verify", "remove"].includes(options.mode) && !options.browserId) {
    throw new Error(`--browser-id is required in ${options.mode} mode`);
  }
  return options;
}

function validatedDebuggerUrl(target, port) {
  const url = new URL(target.webSocketDebuggerUrl);
  const pathIsValid = /^\/devtools\/(?:page|browser)\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname);
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || !pathIsValid) {
    throw new Error("Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape");
  }
  return url.href;
}

function parseCdpMessage(data) {
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

function browserIdFromVersion(version, port) {
  const url = validatedDebuggerUrl(version, port);
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/);
  if (!match || parsed.search || parsed.hash || !BROWSER_ID_PATTERN.test(match[1])) {
    throw new Error("Rejected an invalid CDP browser identity URL");
  }
  return match[1];
}

function isValidCdpPageTarget(item, port) {
  if (item?.type !== "page" || !item.url?.startsWith("app://") || typeof item.id !== "string" ||
      !BROWSER_ID_PATTERN.test(item.id) || !item.webSocketDebuggerUrl) return false;
  try {
    const debuggerUrl = new URL(validatedDebuggerUrl(item, port));
    return debuggerUrl.pathname === `/devtools/page/${item.id}`;
  } catch {
    return false;
  }
}

class CdpSession {
  constructor(target, port) {
    this.target = target;
    this.ws = new WebSocket(validatedDebuggerUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { this.ws.close(); } catch {}
        reject(new Error("CDP WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP WebSocket open failed")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    const message = parseCdpMessage(event.data);
    if (!message) {
      this.close();
      return;
    }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        // Keep the numeric CDP code on the rejection: classifyNativeWindowError
        // reads it directly instead of re-parsing the human-readable message,
        // which Codex builds are free to reword at any time.
        const error = new Error(`${message.error.message} (${message.error.code})`);
        error.cdpCode = message.error.code;
        waiter.reject(error);
      } else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 120000) {
      return Promise.reject(new Error(`Invalid CDP command timeout: ${timeoutMs}`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

class BrowserIdentityAnchor {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.closed = false;
    this.ws.addEventListener("close", () => { this.closed = true; });
    this.ws.addEventListener("error", () => {
      this.closed = true;
      try { this.ws.close(); } catch {}
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error("CDP browser identity WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket open failed"));
      }, { once: true });
      this.ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket closed during startup"));
      }, { once: true });
    });
    if (this.closed) throw new Error("CDP browser identity WebSocket is already closed");
    return this;
  }

  close() {
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

async function fetchCdpJson(port, resource) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function validateBrowserIdentity(port, expectedBrowserId) {
  const version = await fetchCdpJson(port, "/json/version");
  const actualBrowserId = browserIdFromVersion(version, port);
  if (actualBrowserId !== expectedBrowserId) {
    throw new CdpIdentityMismatchError(
      `CDP browser identity changed from ${expectedBrowserId} to ${actualBrowserId}`,
    );
  }
  return version;
}

async function listAppTargets(port, expectedBrowserId = null) {
  const targets = await fetchCdpJson(port, "/json/list");
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  if (expectedBrowserId) await validateBrowserIdentity(port, expectedBrowserId);
  return targets.filter((item) => isValidCdpPageTarget(item, port));
}

async function connectBrowserIdentityAnchor(port, expectedBrowserId) {
  const version = await validateBrowserIdentity(port, expectedBrowserId);
  return new BrowserIdentityAnchor(validatedDebuggerUrl(version, port)).open();
}

const THEME_CHOICES = {
  appearance: new Set(["auto", "light", "dark"]),
  safeArea: new Set(["auto", "left", "right", "center", "none"]),
  taskMode: new Set(["auto", "ambient", "banner", "full", "off"]),
};

function normalizedUnit(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be null or a number between 0 and 1`);
  }
  return number;
}

function normalizedChoice(value, name, choices, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!choices.has(value)) throw new Error(`${name} has an unsupported value: ${value}`);
  return value;
}

function normalizedText(value, name, fallback, maxLength = 120) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${name} must be a short single-line string`);
  }
  return value;
}

function sameFileStat(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isContainedRelativePath(relativePath) {
  return relativePath !== ""
    && !path.isAbsolute(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`);
}

async function loadSafeCss(themeRoot) {
  const cssPath = path.join(themeRoot, "theme.css");
  let handle;
  try {
    handle = await fs.open(cssPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") throw new Error("Theme Safe CSS must not be a symbolic link");
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_SAFE_CSS_BYTES) {
      throw new Error(`Theme Safe CSS must be a non-empty file no larger than ${MAX_SAFE_CSS_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileStat(before, after) || bytes.length !== after.size) {
      throw new Error("Theme Safe CSS changed while being loaded");
    }
    const { source, runtimeSource, validation } = decodeAndValidateSafeCss(bytes);
    return { path: cssPath, runtimeSource, source, stat: after, validation };
  } finally {
    await handle.close();
  }
}

export async function loadTheme(themeDir) {
  const realThemeDir = await fs.realpath(themeDir);
  const themePath = path.join(realThemeDir, "theme.json");
  const themeText = await fs.readFile(themePath, "utf8");
  const raw = JSON.parse(themeText);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Theme root must be an object");
  }
  if (raw.schemaVersion !== 1) {
    throw new Error("Theme must use schemaVersion 1");
  }
  const image = normalizedText(raw.image, "image", null, 240);
  if (!image || path.isAbsolute(image)) throw new Error("Theme image must be a relative path");
  const imagePath = path.resolve(realThemeDir, image);
  const relativeImage = path.relative(realThemeDir, imagePath);
  if (!isContainedRelativePath(relativeImage)) {
    throw new Error("Theme image must remain inside the selected theme directory");
  }
  const extension = path.extname(imagePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new Error(`Unsupported theme image format: ${extension || "missing"}`);
  }
  const realImagePath = await fs.realpath(imagePath);
  const realRelativeImage = path.relative(realThemeDir, realImagePath);
  if (!isContainedRelativePath(realRelativeImage)) {
    throw new Error("Theme image cannot escape through a link or junction");
  }
  const art = raw.art && typeof raw.art === "object" && !Array.isArray(raw.art) ? raw.art : {};
  const rawColors = raw.colors && typeof raw.colors === "object" && !Array.isArray(raw.colors)
    ? raw.colors : null;
  const colorKeys = [
    "background", "panel", "panelAlt", "accent", "accentAlt", "secondary",
    "highlight", "text", "muted", "line",
  ];
  const colors = {
    background: normalizeThemeColor(rawColors?.background, "#071116"),
    panel: normalizeThemeColor(rawColors?.panel, "#0b1a20"),
    panelAlt: normalizeThemeColor(rawColors?.panelAlt, "#10272c"),
    accent: normalizeThemeColor(rawColors?.accent, "#7cff46"),
    accentAlt: normalizeThemeColor(rawColors?.accentAlt, "#b8ff3d"),
    secondary: normalizeThemeColor(rawColors?.secondary, "#36d7e8"),
    highlight: normalizeThemeColor(rawColors?.highlight, "#642a8c"),
    text: normalizeThemeColor(rawColors?.text, "#e9fff1"),
    muted: normalizeThemeColor(rawColors?.muted, "#9ebdb3"),
    line: normalizeThemeColor(rawColors?.line, "rgba(124, 255, 70, .28)"),
  };
  const theme = {
    schemaVersion: 1,
    id: normalizeThemeText(raw.id, "custom", 80, "id", themePath),
    name: normalizeThemeText(raw.name, "Codex Dream Skin", 80, "name", themePath),
    brandSubtitle: normalizeThemeText(raw.brandSubtitle, "CODEX DREAM SKIN", 120, "brandSubtitle", themePath),
    tagline: normalizeThemeText(raw.tagline, "Make something wonderful.", 120, "tagline", themePath),
    projectPrefix: normalizeThemeText(raw.projectPrefix, "选择项目 · ", 120, "projectPrefix", themePath),
    projectLabel: normalizeThemeText(raw.projectLabel, "◉  选择项目", 120, "projectLabel", themePath),
    statusText: normalizeThemeText(raw.statusText, "DREAM SKIN ONLINE", 120, "statusText", themePath),
    quote: normalizeThemeText(raw.quote, "MAKE SOMETHING WONDERFUL", 120, "quote", themePath),
    image,
    appearance: normalizedChoice(raw.appearance, "appearance", THEME_CHOICES.appearance, "auto"),
    art: {
      focusX: normalizedUnit(art.focusX, "art.focusX"),
      focusY: normalizedUnit(art.focusY, "art.focusY"),
      safeArea: normalizedChoice(art.safeArea, "art.safeArea", THEME_CHOICES.safeArea, "auto"),
      taskMode: normalizedChoice(art.taskMode, "art.taskMode", THEME_CHOICES.taskMode, "auto"),
    },
    colorMode: rawColors ? "explicit" : "auto",
    explicitColorKeys: rawColors ? colorKeys.filter((key) => Object.hasOwn(rawColors, key)) : [],
    colors,
  };
  const [themeStat, imageStat, safeCss] = await Promise.all([
    fs.stat(themePath),
    fs.stat(realImagePath),
    loadSafeCss(realThemeDir),
  ]);
  if (!imageStat.isFile()) throw new Error("Theme image is not a file");
  if (imageStat.size < 1) throw new Error("Theme image cannot be empty");
  if (imageStat.size > MAX_ART_BYTES) {
    throw new Error(`Theme image exceeds the ${MAX_ART_BYTES / 1024 / 1024} MB limit`);
  }
  const imageBytes = await fs.readFile(realImagePath);
  if (imageBytes.length < 1 || imageBytes.length > MAX_ART_BYTES) {
    throw new Error(`Theme image must be between 1 byte and ${MAX_ART_BYTES / 1024 / 1024} MB`);
  }
  const artMetadata = readImageMetadata(imageBytes, extension);
  if (!artMetadata) {
    throw new Error("Theme image metadata is invalid or exceeds the 16384px / 50MP safety limit");
  }
  theme.artMetadata = artMetadata;
  const fingerprint = createHash("sha256")
    .update(themeText, "utf8")
    .update("\0")
    .update(imageBytes)
    .update("\0")
    .update(safeCss?.source ?? "")
    .digest("hex");
  return {
    theme,
    themePath,
    imagePath: realImagePath,
    imageBytes,
    safeCss: safeCss?.source ?? "",
    safeCssRuntime: safeCss?.runtimeSource ?? "",
    safeCssPath: safeCss?.path ?? null,
    safeCssStatus: safeCss ? "validated" : "none",
    fingerprint,
    sourceStamp: `${themeStat.size}:${themeStat.mtimeMs}:${imageStat.size}:${imageStat.mtimeMs}:` +
      (safeCss ? `${safeCss.stat.size}:${safeCss.stat.mtimeMs}` : "none"),
  };
}

export async function loadDynamicModuleBundle(engineRoot = root) {
  return loadVersionedDynamicModuleBundle(engineRoot);
}

async function selectedSkinApiVersion(themeDir) {
  const source = await fs.readFile(path.join(themeDir, "theme.json"), "utf8");
  const parsed = JSON.parse(source);
  return parsed?.schemaVersion;
}

async function resolveV2PosterPath(themeDir, theme) {
  const relative = theme.visual.kind === "image" ? theme.visual.asset
    : theme.visual.kind === "video" ? theme.visual.poster
      : theme.visual.fallback.poster;
  const base = relative ? themeDir : path.join(root, "assets");
  const selected = relative ? path.resolve(themeDir, relative) : path.join(base, "dream-reference.jpg");
  const [realRoot, realPath] = await Promise.all([fs.realpath(base), fs.realpath(selected)]);
  if (!isContainedRelativePath(path.relative(realRoot, realPath))) {
    throw new Error("Dynamic theme poster must stay inside its theme directory");
  }
  return realPath;
}

async function loadV2Poster(themeDir, theme) {
  const realPath = await resolveV2PosterPath(themeDir, theme);
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_ART_BYTES) {
      throw new Error("Dynamic theme poster must be a bounded regular file");
    }
    const imageBytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileStat(before, after) || imageBytes.length !== after.size) {
      throw new Error("Dynamic theme poster changed while being loaded");
    }
    const extension = path.extname(realPath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      throw new Error("Dynamic theme poster must be PNG, JPEG, or WebP");
    }
    return { imageBytes, extension, imagePath: realPath };
  } finally {
    await handle.close();
  }
}

function v2LegacyTheme(theme) {
  const defaults = {
    background: "#071116", panel: "#0b1a20", panelAlt: "#10272c",
    accent: "#7cff46", accentAlt: "#b8ff3d", secondary: "#36d7e8",
    highlight: "#642a8c", text: "#e9fff1", muted: "#9ebdb3",
    line: "rgba(124, 255, 70, .28)",
  };
  const colors = { ...defaults, ...theme.tokens };
  return {
    schemaVersion: 1, id: theme.id, name: theme.name,
    brandSubtitle: "CODEX DYNAMIC SKIN", tagline: "Make something wonderful.",
    projectPrefix: "选择项目 · ", projectLabel: "◉  选择项目",
    statusText: "DYNAMIC SKIN READY", quote: "MAKE SOMETHING WONDERFUL",
    image: "<dynamic-poster>", appearance: "auto", art: {},
    colorMode: Object.keys(theme.tokens).length ? "explicit" : "auto",
    explicitColorKeys: Object.keys(theme.tokens), colors,
  };
}

async function buildDynamicAssetBundle(themeDir, assetPaths) {
  const realRoot = await fs.realpath(themeDir);
  const manifest = [];
  for (const assetPath of assetPaths) {
    const mediaType = DYNAMIC_MIME[path.extname(assetPath).toLowerCase()];
    if (!mediaType) throw new Error(`Dynamic theme asset type is unsupported: ${assetPath}`);
    const absolutePath = path.join(realRoot, ...assetPath.split("/"));
    const handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!before.isFile() || !sameFileStat(before, after) || bytes.length !== after.size) {
        throw new Error(`Dynamic theme asset changed while being loaded: ${assetPath}`);
      }
      manifest.push({
        path: assetPath,
        mediaType,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  return { root: realRoot, manifest };
}

async function loadV2Payload(themeDir, {
  backgroundPlaybackSupport = "restart-required",
  displayMode = "theme",
  assetHost = null,
} = {}) {
  const [loadedSkin, modules] = await Promise.all([
    loadInstalledSkin(themeDir, { platform: "windows", clientVersion: "2.0.0" }),
    loadDynamicModuleBundle(root),
  ]);
  if (loadedSkin.sourceApiVersion !== 2) throw new Error("Dynamic payload requires Skin API v2");
  const assetPaths = collectThemeAssetPaths(loadedSkin.theme);
  const deferredAssetUrls = () => Object.fromEntries(assetPaths.map((asset, index) => [
    asset, `dream-skin-deferred://asset/${index}`,
  ]));
  if (displayMode === "native") {
    const assetUrls = deferredAssetUrls();
    const imagePath = await resolveV2PosterPath(themeDir, loadedSkin.theme);
    const revision = appendDynamicModuleRevision(
      createHash("sha256").update(SKIN_VERSION).update(loadedSkin.fingerprint), modules,
    )
      .update(backgroundPlaybackSupport).update(displayMode)
      .digest("hex").slice(0, 20);
    const dynamicPayload = composeDynamicPayload({
      loadedSkin, settings: DEFAULT_DYNAMIC_SETTINGS, assetUrls, revision, modules,
      backgroundPlaybackSupport, displayMode, activation: "deferred",
    });
    const payload = dynamicPayload.source;
    try { new Function(payload); } catch (error) {
      throw new Error(`Payload failed to parse as JavaScript: ${error.message}`);
    }
    const state = {
      theme: loadedSkin.theme, themePath: path.join(themeDir, "theme.json"), imagePath,
      imageBytes: 0, safeCss: "", safeCssRuntime: "", safeCssPath: null,
      safeCssStatus: "none", fingerprint: loadedSkin.fingerprint,
      sourceApiVersion: 2, activation: "deferred", displayMode,
      dynamicPayloadSha256: dynamicPayload.sha256,
      payload, revision,
    };
    state.sourceStamp = await readThemeSourceStamp(state);
    return state;
  }
  const [css, template] = await Promise.all([
    fs.readFile(path.join(root, "assets", "dream-skin.css"), "utf8"),
    fs.readFile(path.join(root, "assets", "renderer-inject.js"), "utf8"),
  ]);
  const poster = await loadV2Poster(themeDir, loadedSkin.theme);
  const theme = v2LegacyTheme(loadedSkin.theme);
  const combinedCss = loadedSkin.safeCssRuntime ? `${css}\n${loadedSkin.safeCssRuntime}\n` : css;
  const artMetadata = readImageMetadata(poster.imageBytes, poster.extension);
  if (!artMetadata) throw new Error("Dynamic theme poster metadata is invalid");
  theme.artMetadata = artMetadata;
  theme.artKey = createHash("sha256").update(poster.imageBytes).digest("hex").slice(0, 20);
  const mime = poster.extension === ".jpg" || poster.extension === ".jpeg" ? "image/jpeg"
    : poster.extension === ".webp" ? "image/webp" : "image/png";
  const artDataUrl = `data:${mime};base64,${poster.imageBytes.toString("base64")}`;
  const styleRevision = createHash("sha256").update(combinedCss).digest("hex").slice(0, 20);
  const revision = appendDynamicModuleRevision(
    createHash("sha256").update(SKIN_VERSION).update(loadedSkin.fingerprint)
      .update(combinedCss).update(template),
    modules,
  ).update(backgroundPlaybackSupport).update(displayMode)
    .digest("hex").slice(0, 20);
  const legacyPayload = template
    .replace("__DREAM_SKIN_CSS_JSON__", () => JSON.stringify(combinedCss))
    .replace("__DREAM_SKIN_ART_JSON__", () => JSON.stringify(artDataUrl))
    .replace("__DREAM_SKIN_THEME_JSON__", () => JSON.stringify(theme))
    .replace("__DREAM_SKIN_VERSION_JSON__", () => JSON.stringify(SKIN_VERSION))
    .replace("__DREAM_SKIN_STYLE_REVISION_JSON__", () => JSON.stringify(styleRevision))
    .replace("__DREAM_SKIN_PAYLOAD_REVISION_JSON__", () => JSON.stringify(revision));
  let assetGeneration = null;
  try {
    let assetUrls = deferredAssetUrls();
    let activation = "deferred";
    if (assetHost) {
      const hostManifest = await buildDynamicAssetBundle(themeDir, assetPaths);
      assetGeneration = await assetHost.stageGeneration(hostManifest);
      assetUrls = Object.fromEntries(assetPaths.map((asset) => [asset, assetGeneration.urlFor(asset)]));
      activation = "active";
    }
    const dynamicPayload = composeDynamicPayload({
      loadedSkin, settings: DEFAULT_DYNAMIC_SETTINGS, assetUrls, revision, modules,
      backgroundPlaybackSupport, displayMode, activation,
    });
    const payload = `${legacyPayload}\n${dynamicPayload.source}`;
    if (/__DREAM_SKIN_[A-Z0-9_]+_JSON__/.test(payload)) {
      throw new Error("Payload placeholders were not fully replaced");
    }
    try { new Function(payload); } catch (error) {
      throw new Error(`Payload failed to parse as JavaScript: ${error.message}`);
    }
    const state = {
      theme: loadedSkin.theme, themePath: path.join(themeDir, "theme.json"), imagePath: poster.imagePath,
      safeCss: loadedSkin.safeCss, safeCssRuntime: loadedSkin.safeCssRuntime,
      safeCssPath: loadedSkin.safeCss ? path.join(themeDir, loadedSkin.theme.styles) : null,
      safeCssStatus: loadedSkin.safeCss ? "validated" : "none", fingerprint: loadedSkin.fingerprint,
      sourceApiVersion: 2, activation, displayMode, assetGeneration,
      imageBytes: poster.imageBytes.length,
      dynamicPayloadSha256: dynamicPayload.sha256,
      payload, revision,
    };
    state.sourceStamp = await readThemeSourceStamp(state);
    return state;
  } catch (error) {
    await assetGeneration?.release();
    throw error;
  }
}

async function loadLegacyPayload(themeDir = path.join(root, "assets"), candidateTheme = null) {
  const loadedTheme = candidateTheme ?? await loadTheme(themeDir);
  const [css, template] = await Promise.all([
    fs.readFile(path.join(root, "assets", "dream-skin.css"), "utf8"),
    fs.readFile(path.join(root, "assets", "renderer-inject.js"), "utf8"),
  ]);
  const combinedCss = loadedTheme.safeCssRuntime
    ? `${css}\n${loadedTheme.safeCssRuntime}\n` : css;
  const extension = path.extname(loadedTheme.imagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : extension === ".webp" ? "image/webp" : "image/png";
  const artDataUrl = `data:${mime};base64,${loadedTheme.imageBytes.toString("base64")}`;
  const styleRevision = createHash("sha256").update(combinedCss).digest("hex").slice(0, 20);
  loadedTheme.theme.artKey = createHash("sha256")
    .update(loadedTheme.imageBytes).digest("hex").slice(0, 20);
  const revision = createHash("sha256")
    .update(SKIN_VERSION)
    .update(combinedCss)
    .update(template)
    .update(JSON.stringify(loadedTheme.theme))
    .digest("hex")
    .slice(0, 20);
  // Every replacement uses a function so String.prototype.replace never
  // interprets $$, $&, $` or $' inside the substituted JSON. Theme text is
  // user-controlled (theme.json legitimately allows "$"), and a literal-string
  // replacement would splice the template source back into the payload -- a
  // stray "$`" produced a SyntaxError, while "$&"/"$$" silently corrupted the
  // theme name.
  const payload = template
    .replace("__DREAM_SKIN_CSS_JSON__", () => JSON.stringify(combinedCss))
    .replace("__DREAM_SKIN_ART_JSON__", () => JSON.stringify(artDataUrl))
    .replace("__DREAM_SKIN_THEME_JSON__", () => JSON.stringify(loadedTheme.theme))
    .replace("__DREAM_SKIN_VERSION_JSON__", () => JSON.stringify(SKIN_VERSION))
    .replace("__DREAM_SKIN_STYLE_REVISION_JSON__", () => JSON.stringify(styleRevision))
    .replace("__DREAM_SKIN_PAYLOAD_REVISION_JSON__", () => JSON.stringify(revision));
  // Defence in depth for every caller, not just --check-payload: a template
  // splice leaves an unreplaced placeholder token behind and usually breaks the
  // syntax outright, so refuse to hand a corrupted script to the renderer.
  if (/__DREAM_SKIN_[A-Z0-9_]+_JSON__/.test(payload)) {
    throw new Error("Payload placeholders were not fully replaced");
  }
  try {
    // Compile-only: this parses the payload and discards the result. It never
    // runs the renderer script here.
    new Function(payload);
  } catch (error) {
    throw new Error(`Payload failed to parse as JavaScript: ${error.message}`);
  }
  const { imageBytes: _imageBytes, ...themeState } = loadedTheme;
  return { ...themeState, payload, revision };
}

export async function loadPayload(themeDir = path.join(root, "assets"), candidateTheme = null,
  dynamicRuntime = {}) {
  // A watcher audit may already have loaded a legacy metadata candidate before
  // this dispatch point. The directory's declared Skin API version remains the
  // authority: never let that candidate downgrade a v2 video theme to the
  // legacy static renderer path.
  if (await selectedSkinApiVersion(themeDir) === 2) {
    return loadV2Payload(themeDir, dynamicRuntime);
  }
  return loadLegacyPayload(themeDir, candidateTheme);
}

function dynamicRuntimeForOptions(options) {
  return {
    backgroundPlaybackSupport: options.backgroundPlaybackCapable ? "supported" : "restart-required",
    assetHost: options.assetHost ?? null,
  };
}

function expectsVisibleDynamicRoot(loadedPayload) {
  return loadedPayload?.sourceApiVersion === 2
    && loadedPayload?.activation === "active"
    && loadedPayload?.displayMode !== "native";
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readThemeSourceStamp(loadedTheme) {
  const [themeStat, imageStat, cssStat] = await Promise.all([
    fs.stat(loadedTheme.themePath),
    fs.stat(loadedTheme.imagePath),
    (loadedTheme.safeCssPath ? fs.stat(loadedTheme.safeCssPath) : Promise.resolve(null)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  return `${themeStat.size}:${themeStat.mtimeMs}:${imageStat.size}:${imageStat.mtimeMs}:` +
    (cssStat ? `${cssStat.size}:${cssStat.mtimeMs}` : "none");
}

async function probeSession(session) {
  return session.evaluate(`(() => {
    const initialRoute = new URLSearchParams(String(location.search || ''))
      .get('initialRoute') || '';
    const pathname = String(location.pathname || '');
    const excludedPetSurface = location.protocol === 'app:' && (
      pathname.endsWith('/avatar-overlay-composition-surface.html') ||
      initialRoute === '/avatar-overlay' || initialRoute.startsWith('/avatar-overlay/')
    );
    const genericCodexSurface = () => {
      if (location.protocol !== 'app:') return false;
      const main = document.querySelector('main, [role="main"]');
      const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      const branded = Boolean(document.querySelector(
        ${stableTestidLiteral("app-shell-header-context-menu-surface")},
      ));
      return Boolean(main && input && branded);
    };
    const markers = {
      shell: Boolean(document.querySelector(${selectorLiteral("shell-main")})),
      sidebar: Boolean(document.querySelector(${selectorLiteral("left-panel")})),
      composer: Boolean(document.querySelector(${selectorLiteral("composer-chrome")})),
      main: Boolean(document.querySelector(${selectorLiteral("home-route")})),
      generic: genericCodexSurface(),
    };
    const settings = Boolean(document.querySelector(${selectorLiteral("settings-panel")})) ||
      Boolean(document.querySelector(${selectorLiteral("appearance-radio")})) ||
      Boolean(document.querySelector(${stableTestidLiteral("theme-preview")}));
    return {
      markers,
      excludedPetSurface,
      codex: !excludedPetSurface && location.protocol === 'app:' &&
        ((markers.shell && markers.sidebar) || settings || markers.main || markers.generic),
    };
  })()`);
}

async function waitForCodexProbe(session, timeoutMs = 1800) {
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    try {
      probe = await probeSession(session);
      if (probe?.codex) return probe;
    } catch {
      // The renderer may be between documents while the early payload waits.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe;
}

async function connectTarget(target, port) {
  return new CdpSession(target, port).open();
}

function unavailableNativeWindow(error) {
  const message = String(error?.message ?? "");
  const cdpCode = Number(error?.cdpCode);
  const withoutCode = message.replace(/\s*\(-?\d+\)\s*$/, "").trim();
  const domainUnsupported = cdpCode === -32601
    || /\(-32601\)\s*$/.test(message)
    || /^method(?: ['"]Browser\.getWindowForTarget['"])? not found$/i.test(withoutCode)
    || /^['"]?Browser\.getWindowForTarget['"]? (?:wasn't|was not) found$/i.test(withoutCode);
  // Codex 26.721.x (Chrome/150) answers -32000 "Browser window not found" for
  // the app's real, focused, on-screen window -- verified live via CDP: the
  // error is identical before and after actually activating the window, while
  // documentVisibility correctly flips hidden -> visible. The domain exists but
  // this build never resolves a window for our target, so -32000 is exactly as
  // uninformative here as -32601 elsewhere. Treat both the same way and lean on
  // documentVisible, which stays a hard requirement in windowPass below, as the
  // real visibility signal. Matches macOS classifyNativeWindowError. See #256.
  const windowNotFound = cdpCode === -32000
    || /\(-32000\)\s*$/.test(message)
    || /^browser window not found$/i.test(withoutCode)
    || /^no window with given target found$/i.test(withoutCode);
  return {
    pass: false,
    bound: false,
    unsupported: domainUnsupported || windowNotFound,
    reason: domainUnsupported ? "browser-window-api-unavailable"
      : windowNotFound ? "browser-window-not-found"
      : "target-window-unavailable",
  };
}

export async function inspectTargetWindow(session, targetId, timeoutMs = 10000) {
  if (typeof targetId !== "string" || !BROWSER_ID_PATTERN.test(targetId)) {
    return { pass: false, bound: false, reason: "invalid-target-id" };
  }

  let binding;
  try {
    binding = await session.send("Browser.getWindowForTarget", { targetId }, timeoutMs);
  } catch (error) {
    return unavailableNativeWindow(error);
  }
  if (!Number.isInteger(binding?.windowId) || binding.windowId <= 0) {
    return { pass: false, bound: false, reason: "invalid-window-binding" };
  }

  let latest;
  try {
    latest = await session.send("Browser.getWindowBounds", { windowId: binding.windowId }, timeoutMs);
  } catch (error) {
    return unavailableNativeWindow(error);
  }
  const bounds = { ...(binding.bounds ?? {}), ...(latest?.bounds ?? {}) };
  const state = typeof bounds.windowState === "string" ? bounds.windowState : null;
  const width = Number.isFinite(bounds.width) ? Number(bounds.width) : null;
  const height = Number.isFinite(bounds.height) ? Number(bounds.height) : null;
  const statePass = VISIBLE_WINDOW_STATES.has(state);
  const boundsPass = width !== null && height !== null &&
    width >= MIN_RENDERER_VIEWPORT_WIDTH && height >= MIN_RENDERER_VIEWPORT_HEIGHT;
  return {
    pass: statePass && boundsPass,
    bound: true,
    windowId: binding.windowId,
    state,
    width,
    height,
    reason: !statePass ? "window-not-visible" : !boundsPass ? "window-bounds-too-small" : null,
  };
}

async function connectCodexTargets(port, timeoutMs, expectedBrowserId) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const targets = await listAppTargets(port, expectedBrowserId);
      const connected = [];
      for (const target of targets) {
        let session;
        try {
          session = await connectTarget(target, port);
          const probe = await probeSession(session);
          if (probe?.codex) connected.push({ target, session, probe });
          else {
            if (probe?.excludedPetSurface && !await cleanupExcludedSurface(session)) {
              throw new Error("Excluded Pet surface cleanup did not verify");
            }
            session.close();
          }
        } catch (error) {
          session?.close();
          lastError = error;
        }
      }
      if (connected.length) return connected;
      lastError = new Error("No page matched the expected Codex shell markers");
    } catch (error) {
      if (error instanceof CdpIdentityMismatchError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error(`No verified Codex renderer on 127.0.0.1:${port}: ${lastError?.message ?? "timed out"}`);
}

async function applyToSession(session, payload) {
  return session.evaluate(payload);
}

export function earlyPayloadFor(payload, revision) {
  return `(() => {
    const generationKey = "__CODEX_DREAM_SKIN_EARLY_GENERATION__";
    const appliedKey = "__CODEX_DREAM_SKIN_EARLY_APPLIED__";
    const generation = ${JSON.stringify(revision)};
    window[generationKey] = generation;
    let bootstrapTimer = null;
    let timeout = null;
    const stop = () => {
      if (bootstrapTimer) clearInterval(bootstrapTimer);
      bootstrapTimer = null;
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };
    const hasCodexSurface = () => {
      if (location.protocol !== "app:") return false;
      const shell = document.querySelector(${selectorLiteral("shell-main")});
      const sidebar = document.querySelector(${selectorLiteral("left-panel")});
      const main = document.querySelector(${selectorLiteral("home-route")});
      const settings = document.querySelector(${selectorLiteral("settings-panel")}) ||
        document.querySelector(${selectorLiteral("appearance-radio")}) ||
        document.querySelector(${stableTestidLiteral("theme-preview")});
      const genericMain = document.querySelector('main, [role="main"]');
      const genericInput = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      const branded = Boolean(document.querySelector(
        ${stableTestidLiteral("app-shell-header-context-menu-surface")},
      ));
      return Boolean((shell && sidebar) || settings || main ||
        (genericMain && genericInput && branded));
    };
    const install = () => {
      if (window[generationKey] !== generation) { stop(); return true; }
      if (window[appliedKey] === generation) { stop(); return true; }
      const root = document.documentElement;
      // The shared renderer can install against documentElement before body is
      // committed; requiring body here would create a visible unskinned first
      // frame on cold navigation.
      if (!root || !hasCodexSurface()) return false;
      stop();
      ${payload};
      window[appliedKey] = generation;
      return true;
    };
    if (install()) return;
    document.addEventListener?.("DOMContentLoaded", install, { once: true });
    bootstrapTimer = setInterval(install, 250);
    timeout = setTimeout(stop, 10000);
  })()`;
}

async function registerEarlyPayload(session, payload, revision) {
  const result = await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: earlyPayloadFor(payload, revision),
  });
  return result.identifier ?? null;
}

async function removeEarlyPayload(session, identifier) {
  if (!identifier || session.closed) return;
  await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
}


function nextOperationToken() {
  operationSequence += 1;
  return `${process.pid}:${Date.now()}:${operationSequence}`;
}

function operationKindMessage(kind) {
  if (kind === "pause") return "正在暂停皮肤…";
  if (kind === "switch") return "正在切换主题…";
  return "正在应用皮肤…";
}

function operationUiExpression(action, token, state = "loading", message = "") {
  const config = { action, token, state, message };
  return `(() => {
    const config = ${JSON.stringify(config)};
    const hostId = ${JSON.stringify(OPERATION_UI_HOST_ID)};
    const registryKey = ${JSON.stringify(OPERATION_UI_REGISTRY_KEY)};
    const css = ${JSON.stringify(OPERATION_UI_CSS)};
    const revealDelayMs = 16;
    const minimumLoadingMs = 700;
    const stateTtl = (value) => value === "loading" ? 180000
      : value === "success" ? 1800 : value === "cancelled" ? 2400 : 6000;
    const issuedAt = (value) => Number(String(value).split(":")[1]) || 0;
    const positionInMainArea = (host) => {
      const main = document.querySelector(${selectorLiteral("shell-main")}) ||
        document.querySelector("main") ||
        document.querySelector('[role="main"]') || document.documentElement;
      const rect = main.getBoundingClientRect();
      const top = Math.max(0, rect.top);
      const left = Math.max(0, rect.left);
      const width = Math.max(1, Math.min(innerWidth - left, rect.width || innerWidth));
      const height = Math.max(1, Math.min(innerHeight - top, rect.height || innerHeight));
      host.style.setProperty("--dream-skin-operation-top", String(top) + "px");
      host.style.setProperty("--dream-skin-operation-left", String(left) + "px");
      host.style.setProperty("--dream-skin-operation-width", String(width) + "px");
      host.style.setProperty("--dream-skin-operation-height", String(height) + "px");
    };
    const clearTimer = (timer) => { if (timer) clearTimeout(timer); };
    const removeHost = (expectedToken, force = false) => {
      const host = document.getElementById(hostId);
      const registry = window[registryKey];
      if (!force && host?.dataset.operationToken !== expectedToken) return false;
      if (!force && registry?.token && registry.token !== expectedToken) return false;
      clearTimer(registry?.showTimer);
      clearTimer(registry?.expiryTimer);
      clearTimer(registry?.terminalTimer);
      host?.remove();
      if (force || registry?.token === expectedToken) delete window[registryKey];
      return true;
    };
    if (config.action === "clear") {
      removeHost("", true);
      return { visible: false, cleared: true };
    }
    if (config.action === "hide") {
      return { visible: false, removed: removeHost(config.token) };
    }
    let host = document.getElementById(hostId);
    if (config.action === "show") {
      const currentIssuedAt = Number(host?.dataset.operationIssuedAt || 0);
      if (host?.dataset.operationToken !== config.token && currentIssuedAt > issuedAt(config.token)) {
        return { visible: false, stale: true };
      }
      removeHost("", true);
      host = document.createElement("div");
      host.id = hostId;
      host.dataset.operationToken = config.token;
      host.dataset.operationIssuedAt = String(issuedAt(config.token));
      host.dataset.state = config.state;
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      host.setAttribute("aria-atomic", "true");
      const rgb = getComputedStyle(document.body || document.documentElement).backgroundColor.match(/\\d+(?:\\.\\d+)?/g)?.map(Number);
      const light = rgb?.length >= 3
        ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) > 150
        : matchMedia("(prefers-color-scheme: light)").matches;
      host.dataset.tone = light ? "light" : "dark";
      positionInMainArea(host);
      const shadow = host.attachShadow({ mode: "open" });
      const styleNode = document.createElement("style");
      styleNode.textContent = css;
      const statusNode = document.createElement("div");
      statusNode.className = "status";
      const indicator = document.createElement("span");
      indicator.className = "indicator";
      indicator.setAttribute("aria-hidden", "true");
      const messageNode = document.createElement("span");
      messageNode.className = "message";
      messageNode.textContent = config.message;
      statusNode.append(indicator, messageNode);
      shadow.append(styleNode, statusNode);
      document.documentElement.append(host);
      const registry = {
        token: config.token,
        startedAt: Date.now(),
        showTimer: null,
        expiryTimer: null,
        terminalTimer: null,
      };
      registry.showTimer = setTimeout(() => {
        const current = document.getElementById(hostId);
        if (current?.dataset.operationToken === config.token) current.dataset.visible = "true";
      }, revealDelayMs);
      registry.expiryTimer = setTimeout(() => removeHost(config.token), stateTtl(config.state));
      window[registryKey] = registry;
      return { visible: true, state: config.state };
    }
    if (!host || host.dataset.operationToken !== config.token) {
      return { visible: false, stale: true };
    }
    const registry = window[registryKey];
    clearTimer(registry?.terminalTimer);
    clearTimer(registry?.expiryTimer);
    positionInMainArea(host);
    const terminal = config.state === "success" || config.state === "error" || config.state === "cancelled";
    const remainingLoadingMs = terminal && host.dataset.state === "loading" && registry?.startedAt
      ? Math.max(0, registry.startedAt + minimumLoadingMs - Date.now())
      : 0;
    if (remainingLoadingMs > 0 && registry?.token === config.token) {
      registry.terminalTimer = setTimeout(() => {
        const current = document.getElementById(hostId);
        const currentRegistry = window[registryKey];
        if (current?.dataset.operationToken !== config.token || currentRegistry?.token !== config.token) return;
        current.dataset.state = config.state;
        current.dataset.visible = "true";
        const currentMessage = current.shadowRoot?.querySelector(".message");
        if (currentMessage) currentMessage.textContent = config.message;
        clearTimer(currentRegistry.expiryTimer);
        currentRegistry.expiryTimer = setTimeout(() => removeHost(config.token), stateTtl(config.state));
      }, remainingLoadingMs);
      return { visible: true, state: "loading", deferred: true };
    }
    host.dataset.state = config.state;
    host.dataset.visible = "true";
    const messageNode = host.shadowRoot?.querySelector(".message");
    if (messageNode) messageNode.textContent = config.message;
    if (registry?.token === config.token) {
      registry.expiryTimer = setTimeout(() => removeHost(config.token), stateTtl(config.state));
    }
    return { visible: true, state: config.state };
  })()`;
}

async function updateOperationUi(session, action, token, state, message, timeoutMs = 10000) {
  if (session.closed) return false;
  const result = await session.evaluate(
    operationUiExpression(action, token, state, message),
    timeoutMs,
  );
  return Boolean(result?.visible || result?.cleared || result?.removed);
}

async function bestEffortOperationUi(session, action, token, state, message, timeoutMs = 10000) {
  try {
    return await updateOperationUi(session, action, token, state, message, timeoutMs);
  } catch (error) {
    console.error(`[dream-skin] client status unavailable: ${error.message}`);
    return false;
  }
}

async function presentOperationUi(session, token, state, message, timeoutMs = 10000) {
  const updated = await bestEffortOperationUi(
    session, "update", token, state, message, timeoutMs,
  );
  if (updated) return true;
  return bestEffortOperationUi(session, "show", token, state, message, timeoutMs);
}

async function removeFromSession(session) {
  return session.evaluate(`(async () => {
    window.__CODEX_DREAM_SKIN_DISABLED__ = true;
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    let cleaned = false;
    try {
      const cleanupResult = typeof state?.cleanup === 'function' ? state.cleanup() : false;
      cleaned = Boolean(await Promise.resolve(cleanupResult));
    } catch {}
    if (cleaned) return true;
    const root = document.documentElement;
    for (const attribute of [...(root?.attributes || [])]) {
      if (attribute.name.startsWith('data-dream-')) root.removeAttribute(attribute.name);
    }
    for (const property of [...(root?.style || [])]) {
      if (property.startsWith('--dream-') || property.startsWith('--ds-')) {
        root.style.removeProperty(property);
      }
    }
    for (const node of document.querySelectorAll('[data-ds-part]')) {
      node.removeAttribute('data-ds-part');
    }
    const sheets = window.__CODEX_DREAM_SKIN_STYLE_SHEETS__;
    if (sheets && 'adoptedStyleSheets' in document) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets]
        .filter((sheet) => !sheets.has(sheet));
    }
    delete window.__CODEX_DREAM_SKIN_STYLE_SHEETS__;
    try { if (state?.artUrl) URL.revokeObjectURL(state.artUrl); } catch {}
    document.getElementById('codex-dream-skin-style')?.remove();
    delete window.__CODEX_DREAM_SKIN_STATE__;
    return true;
  })()`);
}

async function clearPendingRendererRequests(session) {
  return session.evaluate(`(() => {
    delete window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__;
    delete window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__;
    return true;
  })()`, 1500);
}

export async function pollRendererRequests(session, timeoutMs = 1500) {
  return session.evaluate(`(() => {
    const themeKey = "__CODEX_DYNAMIC_SKIN_THEME_REQUEST__";
    const actionKey = "__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__";
    const themeValue = window[themeKey];
    const actionValue = window[actionKey];
    delete window[themeKey];
    delete window[actionKey];
    const themeRequest = themeValue && typeof themeValue === "object"
      && typeof themeValue.id === "string" ? {
        id: themeValue.id,
        fromThemeId: themeValue.fromThemeId,
        generation: themeValue.generation,
        issuedAt: Number.isFinite(themeValue.issuedAt) ? themeValue.issuedAt : 0,
        sequence: Number.isFinite(themeValue.sequence) ? themeValue.sequence : 0,
      } : null;
    const actionRequest = actionValue && typeof actionValue === "object" ? {
      action: actionValue.action,
      themeId: actionValue.themeId,
      targetThemeId: actionValue.targetThemeId,
      generation: actionValue.generation,
      issuedAt: Number.isFinite(actionValue.issuedAt) ? actionValue.issuedAt : 0,
      sequence: Number.isFinite(actionValue.sequence) ? actionValue.sequence : 0,
      settings: actionValue.settings,
    } : null;
    return { themeRequest, actionRequest };
  })()`, timeoutMs);
}

export async function presentUnsupportedThemeAction(session, request) {
  const actionName = request?.action === "delete-theme" ? "删除主题" : "导入媒体";
  const status = JSON.stringify({
    token: `unsupported:${request?.sequence ?? 0}:${request?.issuedAt ?? 0}`,
    state: "error",
    message: `${actionName}尚未在 Windows 版实现，未执行任何更改。`,
    updatedAt: Date.now(),
  });
  return session.evaluate(`(() => {
    const status = ${status};
    window.__CODEX_DYNAMIC_SKIN_LIBRARY_ACTION_STATUS__ = status;
    window.dispatchEvent(new CustomEvent("codex-dynamic-skin-library-status", { detail: status }));
    return true;
  })()`, 1500);
}

async function verifyRemovedSession(session) {
  return session.evaluate(`(() => {
    const root = document.documentElement;
    const hasAttributes = [...root.attributes].some((attribute) =>
      attribute.name.startsWith('data-dream-'));
    const hasVariables = [...root.style].some((property) =>
      property.startsWith('--dream-') || property.startsWith('--ds-'));
    const hasParts = Boolean(document.querySelector('[data-ds-part]'));
    const sheets = window.__CODEX_DREAM_SKIN_STYLE_SHEETS__;
    const hasSheets = Boolean(sheets?.size && 'adoptedStyleSheets' in document &&
      [...document.adoptedStyleSheets].some((sheet) => sheets.has(sheet)));
    return !hasAttributes && !hasVariables && !hasParts && !hasSheets &&
      !document.getElementById('codex-dream-skin-style') &&
      !window.__CODEX_DREAM_SKIN_STATE__;
  })()`);
}

export async function cleanupExcludedSurface(session) {
  if (!await removeFromSession(session)) return false;
  return verifyRemovedSession(session);
}

export async function verifySession(
  session,
  targetId,
  expectedThemeId = null,
  expectedRevision = null,
  evaluationTimeoutMs = 10000,
  expectedDynamic = false,
  allowHiddenDocument = false,
) {
  const nativeWindow = await inspectTargetWindow(session, targetId, evaluationTimeoutMs);
  return session.evaluate(`(() => {
    const box = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const opacity = Number.parseFloat(style.opacity);
      const right = Number.isFinite(r.right) ? r.right : r.x + r.width;
      const bottom = Number.isFinite(r.bottom) ? r.bottom : r.y + r.height;
      let cssVisible = r.width > 0 && r.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        style.contentVisibility !== 'hidden' && (!Number.isFinite(opacity) || opacity > 0);
      try {
        if (typeof node.checkVisibility === 'function') {
          cssVisible = cssVisible && node.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          });
        }
      } catch {}
      const intersectsViewport = right > 0 && bottom > 0 && r.x < innerWidth && r.y < innerHeight;
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        visible: Boolean(node.isConnected !== false && cssVisible && intersectsViewport),
      };
    };
    const homeIndicator = document.querySelector(${selectorLiteral("home-icon")});
    const homeSignal = homeIndicator ?? document.querySelector(${selectorLiteral("game-source")}) ??
      document.querySelector(${selectorLiteral("home-suggestions")});
    const homeRoute = homeSignal?.closest('[role="main"]') ?? null;
    // Codex 26.721.x can render the home content before home-icon. Reuse the
    // already-resolved semantic home container so a healthy home session is
    // not rejected solely because the stricter home-icon selector is late.
    const home = document.querySelector(${selectorLiteral("home-route")}) ?? homeRoute;
    const suggestions = home?.querySelector(${selectorLiteral("home-suggestions")}) ?? null;
    const cardButtons = suggestions ? [...suggestions.querySelectorAll('button')] : [];
    const cards = cardButtons.map(box);
    const visibleCards = cards.filter((item) => item?.visible);
    const suggestionLabels = cardButtons.flatMap((button) => {
      const expectedColor = getComputedStyle(button).color;
      return [...button.querySelectorAll('*')]
        .filter((node) => [...node.childNodes].some((child) =>
          child.nodeType === 3 && child.textContent.trim()))
        .map((node) => ({
          ...box(node),
          text: String(node.textContent ?? "").trim().slice(0, 80),
          color: getComputedStyle(node).color,
          expectedColor,
        }));
    });
    const visibleSuggestionLabels = suggestionLabels.filter((item) => item?.visible);
    const suggestionLabelColorsMatch = visibleSuggestionLabels.every((item) =>
      item.color === item.expectedColor);
    const settingsAnchor = document.querySelector(${selectorLiteral("settings-panel")}) ||
      document.querySelector(${selectorLiteral("appearance-radio")}) ||
      document.querySelector(${stableTestidLiteral("theme-preview")});
    const runtime = window.__CODEX_DREAM_SKIN_STATE__;
    let dynamic = null;
    try {
      if (runtime?.dynamic) {
        dynamic = {
          generation: runtime.dynamic.generation ?? null,
          activation: runtime.dynamic.activation ?? null,
          diagnostics: typeof runtime.dynamic.diagnostics === 'function'
            ? runtime.dynamic.diagnostics() : null,
        };
      }
    } catch {}
    const dynamicRootBoxes = [...document.querySelectorAll('[data-dynamic-skin-root]')].map(box);
    const adopted = runtime?.styleMode === 'adopted' &&
      [...document.adoptedStyleSheets].includes(runtime.styleSheet);
    const fallback = runtime?.styleMode === 'style' &&
      document.getElementById('codex-dream-skin-style') === runtime.styleNode;
    // Codex 26.721+ moved the real home content out of home.firstElementChild's
    // descendant chain: that wrapper now only holds the (usually empty) native
    // .home-banners slot, and the actual content became its sibling instead
    // (see #244). Prefer a sibling of the banner-holding wrapper when present;
    // fall back to the pre-26.721 first-child chain (deepest visible node)
    // otherwise, so older Codex builds keep working unchanged.
    const homeChildren = home?.children ? Array.from(home.children) : [];
    const bannerHolder = homeChildren.find((el) => el.querySelector(${selectorLiteral("home-banners")}));
    const siblingCandidates = homeChildren.filter((el) => el !== bannerHolder).map(box);
    const heroChain = [];
    for (let node = home?.firstElementChild ?? null; node && heroChain.length < 3;
      node = node.firstElementChild) heroChain.push(node);
    const boxableChain = heroChain.filter((node) => typeof node?.getBoundingClientRect === "function");
    const chainCandidates = boxableChain.map(box);
    const hero = siblingCandidates.find((item) => item?.visible && item.width >= 280 && item.height >= 120)
      ?? chainCandidates.findLast((item) => item?.visible)
      ?? siblingCandidates.find((item) => item?.visible)
      ?? box(boxableChain[boxableChain.length - 1]);
    const result = {
      installed: document.documentElement.getAttribute('data-dream-skin') === 'active',
      version: runtime?.version ?? null,
      expectedVersion: ${JSON.stringify(SKIN_VERSION)},
      themeId: runtime?.themeId ?? null,
      revision: runtime?.revision ?? null,
      dynamic,
      dynamicRootCount: dynamicRootBoxes.length,
      visibleDynamicRootCount: dynamicRootBoxes.filter((item) => item?.visible).length,
      styleMode: runtime?.styleMode ?? null,
      stylePresent: Boolean(adopted || fallback),
      scope: runtime?.scope ?? null,
      businessClassPollution: [...document.querySelectorAll('[class]')].filter((node) =>
        [...node.classList].some((name) => /^(?:dream-|codex-dream-skin(?:-|$))/.test(name))
      ).length,
      homePresent: Boolean(home),
      suggestionsPresent: Boolean(suggestions),
      homeSurface: box(home),
      settingsAnchor: box(settingsAnchor),
      hero,
      cards,
      visibleCardCount: visibleCards.length,
      suggestionLabels,
      suggestionLabelColorsMatch,
      composer: box(document.querySelector(${selectorLiteral("composer-chrome")})),
      shell: box(document.querySelector(${selectorLiteral("shell-main")})),
      sidebar: box(document.querySelector(${selectorLiteral("left-panel")})),
      genericMain: box(document.querySelector('[data-ds-part="main"], [data-ds-part="home"]')),
      genericInput: box(document.querySelector('[data-ds-part="composer"]')),
      nativeWindow: ${JSON.stringify(nativeWindow)},
      documentVisibility: document.visibilityState ?? null,
      documentHidden: document.hidden === true,
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: {
        x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      },
    };
    const homeScope = result.scope?.baseState === 'home' || result.homePresent;
    const l1ScopePass = result.scope?.level === 'L1' &&
      Array.isArray(result.scope?.missingL1) && result.scope.missingL1.length === 0;
    const genericStructurePass = l1ScopePass && Boolean(result.genericMain?.visible) &&
      Boolean(result.genericInput?.visible || (homeScope && result.homeSurface?.visible));
    const l0StructurePass = result.scope?.level === 'L0' &&
      result.scope?.baseState === 'settings' && Boolean(result.settingsAnchor?.visible);
    const structurePass = l0StructurePass || (l1ScopePass &&
      (Boolean(result.shell?.visible && result.sidebar?.visible) || genericStructurePass));
    const documentPass = result.documentVisibility === 'visible' && !result.documentHidden;
    const hiddenDocumentAllowed = ${JSON.stringify(allowHiddenDocument)} === true &&
      result.documentVisibility === 'hidden' && result.documentHidden === true;
    const documentReady = documentPass || hiddenDocumentAllowed;
    const viewportPass = result.viewport.width >= ${MIN_RENDERER_VIEWPORT_WIDTH} &&
      result.viewport.height >= ${MIN_RENDERER_VIEWPORT_HEIGHT};
    const nativeWindowPass = result.nativeWindow?.pass === true;
    // Codex 26.721.x (Chrome/150) cannot resolve a native window for our target
    // even when that window is real, focused and on-screen (-32000), and older
    // builds omit the Browser domain outright (-32601). The injector classifies
    // both as unsupported; in that case fall back to the renderer's own
    // visibility evidence instead of failing every install. documentPass and
    // viewportPass below stay hard requirements, so a genuinely hidden or
    // collapsed window still fails closed. Mirrors the macOS
    // assessRendererVerification fallbackWindowPass. See #256.
    const fallbackWindowPass = result.nativeWindow?.unsupported === true;
    const windowPass = nativeWindowPass || fallbackWindowPass;
    const expectedThemeId = ${JSON.stringify(expectedThemeId)};
    const expectedRevision = ${JSON.stringify(expectedRevision)};
    const payloadPass = (!expectedThemeId || result.themeId === expectedThemeId) &&
      (!expectedRevision || result.revision === expectedRevision);
    const expectedDynamic = ${JSON.stringify(expectedDynamic)};
    const mediaDiagnostics = result.dynamic?.diagnostics?.modules?.['media-layer'];
    const intentionallyBackgroundPaused = mediaDiagnostics?.mode === 'video' &&
      mediaDiagnostics.backgroundPlayback === false;
    const videoPlaybackPass = mediaDiagnostics?.mode !== 'video' || (
      mediaDiagnostics.loop === true &&
      (mediaDiagnostics.playing === true || intentionallyBackgroundPaused)
    );
    const dynamicPass = !expectedDynamic || (
      result.dynamic?.activation === 'active' && result.dynamic?.diagnostics?.phase === 'active' &&
      videoPlaybackPass && result.dynamicRootCount === 1 && result.visibleDynamicRootCount === 1
    );
    result.expectedThemeId = expectedThemeId;
    result.expectedRevision = expectedRevision;
    result.expectedDynamic = expectedDynamic;
    result.dynamicPass = dynamicPass;
    result.readiness = {
      windowPass, documentPass, hiddenDocumentAllowed, viewportPass, structurePass,
      nativeWindowPass, fallbackWindowPass,
    };
    const homePass = !homeScope || (
      result.homePresent && Boolean(result.homeSurface?.visible) &&
      ((result.hero?.visible && result.hero.width >= 280 && result.hero.height >= 120) ||
        Boolean(result.genericMain?.visible)) &&
      (!result.suggestionsPresent || result.visibleCardCount === 0 || (
        result.suggestionLabels.filter((item) => item?.visible).length >= result.visibleCardCount &&
        result.suggestionLabelColorsMatch
      ))
    );
    result.pass = result.installed && result.version === result.expectedVersion &&
      result.stylePresent && result.businessClassPollution === 0 && windowPass &&
      documentReady && viewportPass && structurePass &&
      payloadPass && dynamicPass && homePass;
    return result;
  })()`, evaluationTimeoutMs);
}

async function waitForVerifiedSession(
  session,
  targetId,
  timeoutMs,
  expectedThemeId = null,
  expectedRevision = null,
  expectedDynamic = false,
  allowHiddenDocument = false,
) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastResult = await verifySession(
        session, targetId, expectedThemeId, expectedRevision, 10000, expectedDynamic,
        allowHiddenDocument,
      );
      lastError = null;
      if (lastResult.pass) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!lastResult && lastError) throw lastError;
  return lastResult;
}

async function capture(session, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function runBeginOperation(options) {
  const connected = await connectCodexTargets(options.port, options.timeoutMs, options.browserId);
  const operationToken = options.operationToken ?? nextOperationToken();
  let shown = false;
  try {
    const results = await Promise.all(connected.map(({ session }) => presentOperationUi(
      session,
      operationToken,
      "loading",
      operationKindMessage(options.operationKind),
      Math.max(250, Math.floor(options.timeoutMs / 2)),
    )));
    shown = results.some(Boolean);
  } finally {
    for (const { session } of connected) session.close();
  }
  if (!shown) throw new Error("Could not show operation progress in the verified Codex renderer");
  process.stdout.write(`${operationToken}\n`);
}

async function runFinishOperation(options) {
  const connected = await connectCodexTargets(options.port, options.timeoutMs, options.browserId);
  let shown = false;
  try {
    const results = await Promise.all(connected.map(({ session }) => presentOperationUi(
      session,
      options.operationToken,
      options.operationUiState,
      options.operationMessage,
      Math.max(250, Math.floor(options.timeoutMs / 2)),
    )));
    shown = results.some(Boolean);
  } finally {
    for (const { session } of connected) session.close();
  }
  if (!shown) throw new Error("Could not show the completed operation state in the verified Codex renderer");
}

async function runOneShot(options) {
  const connected = await connectCodexTargets(options.port, options.timeoutMs, options.browserId);
  const operationToken = options.mode === "once" || options.mode === "remove"
    ? options.operationToken ?? nextOperationToken()
    : null;
  if (operationToken) {
    const message = options.mode === "remove" ? "正在暂停皮肤…" : "正在准备皮肤…";
    const action = options.operationToken ? presentOperationUi : (session, token, state, text) =>
      bestEffortOperationUi(session, "show", token, state, text);
    await Promise.all(connected.map(({ session }) => action(
      session, operationToken, "loading", message,
    )));
  }
  let loadedPayload = null;
  try {
    loadedPayload = (options.mode === "once" || options.mode === "verify" || options.reload)
      ? await loadPayload(options.themeDir, null, dynamicRuntimeForOptions(options)) : null;
  } catch (error) {
    if (operationToken) {
      await Promise.all(connected.map(({ session }) => presentOperationUi(
        session, operationToken, "error", "皮肤准备失败",
      )));
    }
    for (const { session } of connected) session.close();
    throw error;
  }
  const payload = loadedPayload?.payload ?? null;
  const results = [];
  let screenshotCaptured = false;
  try {
    for (const { target, session, probe } of connected) {
      try {
        if (options.mode === "remove") await removeFromSession(session);
        else if (options.mode === "once") {
          if (operationToken) {
            await bestEffortOperationUi(
              session, "update", operationToken, "loading",
              `正在应用「${loadedPayload.theme.name}」…`,
            );
          }
          await applyToSession(session, payload);
          await new Promise((resolve) => setTimeout(resolve, 850));
        }
        if (options.reload) {
          await session.send("Page.reload", { ignoreCache: true });
          await new Promise((resolve) => setTimeout(resolve, 1600));
          if (options.mode !== "remove") {
            if (operationToken) {
              await presentOperationUi(
                session, operationToken, "loading",
                `正在应用「${loadedPayload.theme.name}」…`,
              );
            }
            await applyToSession(session, payload);
          }
        }
        if (operationToken) {
          await presentOperationUi(
            session,
            operationToken,
            "loading",
            options.mode === "remove" ? "正在确认皮肤已暂停…" : "正在检查显示效果…",
          );
        }
        const verified = options.mode === "remove"
          ? await verifyRemovedSession(session)
          : (options.reload || options.mode === "once" || options.mode === "verify")
            ? await waitForVerifiedSession(
              session,
              target.id,
              options.timeoutMs,
              loadedPayload?.theme.id ?? null,
              loadedPayload?.revision ?? null,
              expectsVisibleDynamicRoot(loadedPayload),
            )
            : await verifySession(session, target.id);
        results.push({ targetId: target.id, markers: probe.markers, result: verified });
        if (operationToken) {
          const passed = options.mode === "remove" ? verified === true : verified?.pass;
          await presentOperationUi(
            session,
            operationToken,
            passed ? "success" : "error",
            passed
              ? options.mode === "remove" ? "皮肤已暂停" : `已应用「${loadedPayload.theme.name}」`
              : options.mode === "remove" ? "暂停校验失败" : "显示校验失败",
          );
        }
        if (options.screenshot && !screenshotCaptured) {
          if (operationToken) {
            await bestEffortOperationUi(session, "hide", operationToken, "loading", "");
          }
          await capture(session, options.screenshot);
          screenshotCaptured = true;
        }
      } catch (error) {
        if (operationToken) {
          await presentOperationUi(
            session,
            operationToken,
            "error",
            options.mode === "remove" ? "暂停失败，请重试" : "应用失败，请重试",
          );
        }
        results.push({ targetId: target.id, markers: probe?.markers, error: error.message });
      } finally {
        session.close();
      }
    }
  } finally {
    for (const { session } of connected) session.close();
  }
  console.log(JSON.stringify({ mode: options.mode, port: options.port, targets: results }, null, 2));
  const failed = results.length === 0 || results.some((item) =>
    item.error || (options.mode === "remove" ? item.result !== true : !item.result?.pass));
  if (failed) process.exitCode = 2;
}

async function runOwnedWatch(options) {
  const identityAnchor = await connectBrowserIdentityAnchor(options.port, options.browserId);
  const sessions = new Map();
  const earlyScripts = new Map();
  const fallbackTargets = new Map();
  const fallbackListeners = new Set();
  const recoveryQueues = new Map();
  const readyTargets = new Set();
  const pollFailures = new Map();
  const healthFailures = new Map();
  const nextHealthChecks = new Map();
  const targetFailures = new Map();
  const lastThemeRequestSequences = new Map();
  const lastThemeActionRequestSequences = new Map();
  const selectionFile = options.pauseFile
    ? themeSelectionPath({ pauseFile: options.pauseFile }) : null;
  let stopping = false;
  let listFailures = 0;
  let lastListErrorLogAt = 0;
  let lastThemeErrorLogAt = 0;
  let lastStrongThemeAuditAt = 0;
  let loadedPayload = null;
  let displayMode = "theme";
  let paused = false;
  const stop = () => { stopping = true; };
  const rejectTarget = (target, baseDelayMs, error = null) => {
    const previous = targetFailures.get(target.id) ?? { failures: 0, lastLogAt: 0 };
    const failures = previous.failures + 1;
    const delayMs = Math.min(30000, baseDelayMs * (2 ** Math.min(failures - 1, 4)));
    const now = Date.now();
    if (error && (failures === 1 || now - previous.lastLogAt >= 30000)) {
      console.error(`[dream-skin] inject failed for ${target.id}: ${error.message}; retrying in ${delayMs}ms`);
      previous.lastLogAt = now;
    }
    targetFailures.set(target.id, { failures, lastLogAt: previous.lastLogAt, until: now + delayMs });
  };
  const detachSessionState = (id) => {
    readyTargets.delete(id);
    pollFailures.delete(id);
    healthFailures.delete(id);
    nextHealthChecks.delete(id);
    lastThemeRequestSequences.delete(id);
    lastThemeActionRequestSequences.delete(id);
    fallbackTargets.delete(id);
    fallbackListeners.delete(id);
  };
  const recoverRenderer = async (id, session, reason) => {
    if (stopping || sessions.get(id) !== session || session.closed) return false;
    readyTargets.delete(id);
    lastThemeRequestSequences.delete(id);
    lastThemeActionRequestSequences.delete(id);
    pollFailures.delete(id);
    await clearPendingRendererRequests(session);
    if (paused) {
      if (!await verifyRemovedSession(session)) {
        await removeFromSession(session);
        if (!await verifyRemovedSession(session)) throw new Error("Recovered pause verification failed");
      }
    } else {
      let verified = await verifySession(
        session, id, loadedPayload.theme.id, loadedPayload.revision, 2000,
        expectsVisibleDynamicRoot(loadedPayload), true,
      ).catch(() => null);
      if (!verified?.pass) {
        await applyToSession(session, loadedPayload.payload);
        verified = await waitForVerifiedSession(
          session,
          id,
          Math.min(options.timeoutMs, 8000),
          loadedPayload.theme.id,
          loadedPayload.revision,
          expectsVisibleDynamicRoot(loadedPayload),
          true,
        );
      }
      if (!verified?.pass) throw new Error("Recovered theme verification failed");
    }
    if (stopping || sessions.get(id) !== session || session.closed) return false;
    healthFailures.set(id, 0);
    nextHealthChecks.set(id, Date.now() + 4000);
    readyTargets.add(id);
    console.log(`[dream-skin] recovered renderer ${id} after ${reason}`);
    return true;
  };
  const createRecoveryQueue = (id, session) => createRendererRecoveryQueue({
    isCurrent: () => !stopping && sessions.get(id) === session && !session.closed,
    recover: (reason) => recoverRenderer(id, session, reason),
    onFailure: async (error, reason) => {
      console.error(`[dream-skin] renderer recovery failed for ${id} (${reason}): ${error.message}`);
      if (sessions.get(id) !== session) return;
      sessions.delete(id);
      await removeEarlyPayload(session, earlyScripts.get(id));
      earlyScripts.delete(id);
      detachSessionState(id);
      session.close();
    },
  });
  const attachLoadFallback = (id, target, session) => {
    if (fallbackListeners.has(id)) return;
    fallbackListeners.add(id);
    session.on("Page.loadEventFired", () => {
      if (paused || !fallbackTargets.get(id)) return;
      const queue = recoveryQueues.get(id);
      if (queue?.request("Page.loadEventFired", { delayMs: 250 })) readyTargets.delete(id);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    loadedPayload = await loadPayload(options.themeDir, null, dynamicRuntimeForOptions(options));
    const initialSelection = selectionFile ? await readThemeSelection(selectionFile) : null;
    if (initialSelection?.themeId === loadedPayload.theme.id && initialSelection.mode === "native") {
      displayMode = "native";
      const themedPayload = loadedPayload;
      const nativePayload = await loadPayload(options.themeDir, null, {
        ...dynamicRuntimeForOptions(options), displayMode,
      });
      loadedPayload = nativePayload;
      await themedPayload.assetGeneration?.release();
    }
    if (selectionFile) {
      await writeThemeSelection(selectionFile, loadedPayload.theme.id, displayMode, {
        allowAcceptanceThemePersistence: options.allowAcceptanceThemePersistence,
      });
    }
    lastStrongThemeAuditAt = Date.now();
    paused = await fileExists(options.pauseFile);
    while (!stopping) {
      if (identityAnchor.closed) {
        console.error("[dream-skin] original CDP browser identity closed; watcher is stopping instead of reconnecting");
        process.exitCode = 3;
        break;
      }
      let targets = [];
      try {
        targets = await listAppTargets(options.port);
        listFailures = 0;
      } catch (error) {
        listFailures += 1;
        const retryMs = Math.min(10000, 1000 * (2 ** Math.min(listFailures - 1, 4)));
        if (listFailures === 1 || Date.now() - lastListErrorLogAt >= 30000) {
          console.error(`[dream-skin] ${new Date().toISOString()} ${error.message}; retrying in ${retryMs}ms`);
          lastListErrorLogAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }

      const nextPaused = await fileExists(options.pauseFile);
      let nextPayload = loadedPayload;
      let requestedDisplayMode = null;
      if (!nextPaused) {
        try {
          const rendererThemeRequests = [];
          const rendererActionRequests = [];
          for (const [id, session] of sessions) {
            if (!readyTargets.has(id) || recoveryQueues.get(id)?.pending()) continue;
            let rendererPoll;
            try {
              rendererPoll = await pollRendererRequests(session, 1500);
              pollFailures.set(id, 0);
            } catch {
              const failures = (pollFailures.get(id) ?? 0) + 1;
              pollFailures.set(id, failures);
              if (failures >= 3) {
                pollFailures.set(id, 0);
                console.warn(`[dream-skin] renderer request channel ${id} is unresponsive; repairing`);
                if (recoveryQueues.get(id)?.request("request-poll-failed")) readyTargets.delete(id);
              }
              continue;
            }
            const themeRequest = rendererPoll?.themeRequest ?? null;
            const validatedThemeRequest = validateThemeRequest(themeRequest, {
              currentThemeId: loadedPayload.theme.id,
              currentRevision: loadedPayload.revision,
              lastSequence: lastThemeRequestSequences.get(id) ?? 0,
            });
            if (validatedThemeRequest) {
              lastThemeRequestSequences.set(id, validatedThemeRequest.sequence);
              rendererThemeRequests.push(validatedThemeRequest);
            }

            const actionRequest = rendererPoll?.actionRequest ?? null;
            const validatedActionRequest = validateThemeActionRequest(actionRequest, {
              currentThemeId: loadedPayload.theme.id,
              currentRevision: loadedPayload.revision,
              lastSequence: lastThemeActionRequestSequences.get(id) ?? 0,
            });
            if (validatedActionRequest) {
              lastThemeActionRequestSequences.set(id, validatedActionRequest.sequence);
              if (["import-media", "delete-theme"].includes(validatedActionRequest.action)) {
                await presentUnsupportedThemeAction(session, validatedActionRequest).catch(() => false);
              } else {
                rendererActionRequests.push(validatedActionRequest);
              }
            }
          }

          const requestedAction = selectLatestThemeActionRequest(rendererActionRequests);
          const requestedTheme = selectLatestThemeRequest(rendererThemeRequests);
          if (requestedAction?.action === "restore-default-theme") {
            requestedDisplayMode = "native";
          } else if (requestedTheme?.id === loadedPayload.theme.id && displayMode === "native") {
            requestedDisplayMode = "theme";
          } else if (requestedTheme?.id && requestedTheme.id !== loadedPayload.theme.id) {
            console.error(`[dream-skin] rejected unknown Windows theme request ${requestedTheme.id}`);
          }

          if (requestedDisplayMode && requestedDisplayMode !== displayMode) {
            nextPayload = await loadPayload(options.themeDir, null, {
              ...dynamicRuntimeForOptions(options), displayMode: requestedDisplayMode,
            });
          }

          if (nextPayload === loadedPayload) {
            const now = Date.now();
            let shouldAudit = !loadedPayload
              || now - lastStrongThemeAuditAt >= STRONG_THEME_AUDIT_MS;
            if (!shouldAudit) {
              try {
                shouldAudit = await readThemeSourceStamp(loadedPayload) !== loadedPayload.sourceStamp;
              } catch {
                shouldAudit = true;
              }
            }
            if (shouldAudit) {
              lastStrongThemeAuditAt = now;
              if (loadedPayload?.sourceApiVersion === 2) {
                const candidatePayload = await loadPayload(options.themeDir, null, {
                  ...dynamicRuntimeForOptions(options), displayMode,
                });
                if (candidatePayload.revision !== loadedPayload.revision) {
                  nextPayload = candidatePayload;
                } else {
                  loadedPayload.sourceStamp = candidatePayload.sourceStamp;
                  await candidatePayload.assetGeneration?.release();
                }
              } else {
                const candidateTheme = await loadTheme(options.themeDir);
                if (!loadedPayload || candidateTheme.fingerprint !== loadedPayload.fingerprint) {
                  nextPayload = await loadPayload(options.themeDir, candidateTheme, {
                    ...dynamicRuntimeForOptions(options), displayMode,
                  });
                } else {
                  loadedPayload.sourceStamp = candidateTheme.sourceStamp;
                }
              }
            }
          }
        } catch (error) {
          if (Date.now() - lastThemeErrorLogAt >= 30000) {
            console.error(`[dream-skin] theme update rejected: ${error.message}; keeping the active theme`);
            lastThemeErrorLogAt = Date.now();
          }
        }
      }
      const pauseChanged = nextPaused !== paused;
      const payloadChanged = !nextPaused && nextPayload !== loadedPayload;
      const previousPayload = loadedPayload;
      loadedPayload = nextPayload;
      if (payloadChanged) displayMode = loadedPayload.displayMode ?? "theme";
      paused = nextPaused;

      if (pauseChanged || payloadChanged) {
        for (const [id, session] of sessions) {
          try {
            await recoveryQueues.get(id)?.idle();
            if (sessions.get(id) !== session || session.closed) continue;
            readyTargets.delete(id);
            const previousEarlyScript = earlyScripts.get(id);
            if (paused) {
              await removeFromSession(session);
              await removeEarlyPayload(session, previousEarlyScript);
              earlyScripts.delete(id);
              fallbackTargets.delete(id);
              if (!await verifyRemovedSession(session)) {
                throw new Error("Live pause verification failed");
              }
            } else {
              let nextEarlyScript = null;
              try {
                nextEarlyScript = await registerEarlyPayload(
                  session,
                  loadedPayload.payload,
                  loadedPayload.revision,
                );
                if (!nextEarlyScript) throw new Error("CDP did not return an early-script identifier");
                fallbackTargets.set(id, false);
              } catch (error) {
                fallbackTargets.set(id, true);
                console.error(`[dream-skin] early theme refresh unavailable for ${id}: ${error.message}`);
                attachLoadFallback(id, { id }, session);
              }
              if (nextEarlyScript) earlyScripts.set(id, nextEarlyScript);
              else earlyScripts.delete(id);
              await removeEarlyPayload(session, previousEarlyScript);
              await applyToSession(session, loadedPayload.payload);
              const verified = await waitForVerifiedSession(
                session,
                id,
                Math.min(options.timeoutMs, 8000),
                loadedPayload.theme.id,
                loadedPayload.revision,
                expectsVisibleDynamicRoot(loadedPayload),
                true,
              );
              if (!verified?.pass) throw new Error("Live theme update verification failed");
            }
            healthFailures.set(id, 0);
            nextHealthChecks.set(id, Date.now() + 4000);
            readyTargets.add(id);
          } catch (error) {
            console.error(`[dream-skin] live theme update failed for ${id}: ${error.message}`);
            await removeEarlyPayload(session, earlyScripts.get(id));
            earlyScripts.delete(id);
            sessions.delete(id);
            await recoveryQueues.get(id)?.close();
            recoveryQueues.delete(id);
            detachSessionState(id);
            session.close();
          }
        }
        if (payloadChanged) await previousPayload.assetGeneration?.release();
        if (payloadChanged && selectionFile) {
          await writeThemeSelection(selectionFile, loadedPayload.theme.id, displayMode, {
            allowAcceptanceThemePersistence: options.allowAcceptanceThemePersistence,
          });
        }
        console.log(paused ? "[dream-skin] paused" : `[dream-skin] active theme ${loadedPayload.theme.id}`);
      }

      const activeIds = new Set(targets.map((target) => target.id));
      for (const id of targetFailures.keys()) {
        if (!activeIds.has(id)) targetFailures.delete(id);
      }
      for (const [id, session] of sessions) {
        if (!activeIds.has(id) || session.closed) {
          sessions.delete(id);
          await recoveryQueues.get(id)?.close();
          recoveryQueues.delete(id);
          await removeEarlyPayload(session, earlyScripts.get(id));
          earlyScripts.delete(id);
          detachSessionState(id);
          session.close();
          targetFailures.delete(id);
        }
      }

      const healthNow = Date.now();
      for (const [id, session] of sessions) {
        if (!readyTargets.has(id) || recoveryQueues.get(id)?.pending()
            || healthNow < (nextHealthChecks.get(id) ?? 0)) continue;
        nextHealthChecks.set(id, healthNow + 4000);
        try {
          const verified = paused
            ? await verifyRemovedSession(session)
            : await verifySession(
              session, id, loadedPayload.theme.id, loadedPayload.revision, 1500,
              expectsVisibleDynamicRoot(loadedPayload), true,
            );
          const passed = paused ? verified === true : verified?.pass === true;
          if (!passed) throw new Error("renderer state did not match the active watcher state");
          healthFailures.set(id, 0);
        } catch (error) {
          const failures = (healthFailures.get(id) ?? 0) + 1;
          healthFailures.set(id, failures);
          if (failures >= 2) {
            healthFailures.set(id, 0);
            console.warn(`[dream-skin] renderer verification failed for ${id}: ${error.message}; repairing`);
            if (recoveryQueues.get(id)?.request("periodic-verification-failed")) {
              readyTargets.delete(id);
            }
          }
        }
      }

      for (const target of targets) {
        if (identityAnchor.closed) break;
        if (sessions.has(target.id)) continue;
        if ((targetFailures.get(target.id)?.until ?? 0) > Date.now()) continue;
        let session;
        let earlyScriptId = null;
        try {
          session = await connectTarget(target, options.port);
          if (identityAnchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
          let earlyInjectionFallback = false;
          if (!paused) {
            try {
              earlyScriptId = await registerEarlyPayload(
                session,
                loadedPayload.payload,
                loadedPayload.revision,
              );
              if (!earlyScriptId) throw new Error("CDP did not return an early-script identifier");
              await session.evaluate(earlyPayloadFor(loadedPayload.payload, loadedPayload.revision));
            } catch (error) {
              await removeEarlyPayload(session, earlyScriptId);
              earlyScriptId = null;
              earlyInjectionFallback = true;
              console.error(`[dream-skin] early injection unavailable for ${target.id}: ${error.message}`);
            }
          }
          const probe = await waitForCodexProbe(session);
          if (!probe?.codex) {
            await removeEarlyPayload(session, earlyScriptId);
            if (probe?.excludedPetSurface && !await cleanupExcludedSurface(session)) {
              throw new Error("Excluded Pet surface cleanup did not verify");
            }
            rejectTarget(target, 5000);
            session.close();
            continue;
          }
          await clearPendingRendererRequests(session);
          fallbackTargets.set(target.id, earlyInjectionFallback);
          if (identityAnchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
          let earlyApplied = false;
          if (!paused && !earlyInjectionFallback) {
            earlyApplied = await session.evaluate(
              `window.__CODEX_DREAM_SKIN_EARLY_APPLIED__ === ${JSON.stringify(loadedPayload.revision)}`,
            ).catch(() => false);
          }
          sessions.set(target.id, session);
          const recoveryQueue = createRecoveryQueue(target.id, session);
          recoveryQueues.set(target.id, recoveryQueue);
          if (earlyInjectionFallback) attachLoadFallback(target.id, target, session);
          if (earlyScriptId) earlyScripts.set(target.id, earlyScriptId);
          if (paused) {
            await removeFromSession(session);
            if (!await verifyRemovedSession(session)) throw new Error("Initial pause verification failed");
          } else {
            if (!earlyApplied) await applyToSession(session, loadedPayload.payload);
            const verified = await waitForVerifiedSession(
              session,
              target.id,
              Math.min(options.timeoutMs, 8000),
              loadedPayload.theme.id,
              loadedPayload.revision,
              expectsVisibleDynamicRoot(loadedPayload),
              true,
            );
            if (!verified?.pass) throw new Error("Initial theme verification failed");
          }
          readyTargets.add(target.id);
          healthFailures.set(target.id, 0);
          nextHealthChecks.set(target.id, Date.now() + 4000);
          targetFailures.delete(target.id);
          console.log(`[dream-skin] injected target ${target.id}`);
        } catch (error) {
          if (sessions.get(target.id) === session) sessions.delete(target.id);
          await recoveryQueues.get(target.id)?.close();
          recoveryQueues.delete(target.id);
          await removeEarlyPayload(session, earlyScriptId);
          detachSessionState(target.id);
          session?.close();
          if (identityAnchor.closed || error instanceof CdpIdentityMismatchError) break;
          rejectTarget(target, 2500, error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    identityAnchor.close();
    for (const [id, session] of sessions) {
      sessions.delete(id);
      await recoveryQueues.get(id)?.close();
      await removeEarlyPayload(session, earlyScripts.get(id));
      session.close();
    }
    await loadedPayload?.assetGeneration?.release();
    recoveryQueues.clear();
    earlyScripts.clear();
    fallbackTargets.clear();
    fallbackListeners.clear();
  }
}

async function runWatch(options) {
  const lease = await acquireWatcherLease({ port: options.port });
  let assetHost = null;
  try {
    assetHost = await createAssetHost({
      logger: ({ phase, category, code }) => {
        console.error(`[dream-skin] ${phase} ${category}: ${code}`);
      },
    });
    assetHost.bindRendererOrigin("app://codex");
    await runOwnedWatch({ ...options, assetHost });
  } finally {
    await assetHost?.close();
    await lease.release();
  }
}

async function runExclusiveOneShot(options) {
  const mutatesRenderer = options.mode === "once" || options.mode === "remove" || options.reload;
  if (mutatesRenderer) await validateBrowserIdentity(options.port, options.browserId);
  const lease = mutatesRenderer ? await acquireWatcherLease({ port: options.port }) : null;
  try {
    await runOneShot(options);
  } finally {
    await lease?.release();
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(scriptPath)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "self-test") {
  const valid = validatedDebuggerUrl({ webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/page/test` }, options.port);
  const browserId = browserIdFromVersion({
    webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser/test-browser`,
  }, options.port);
  const invalid = [
    "ws://example.com/devtools/page/test",
    `ws://127.0.0.1:${options.port + 1}/devtools/page/test`,
    `wss://127.0.0.1:${options.port}/devtools/page/test`,
    `ws://user@127.0.0.1:${options.port}/devtools/page/test`,
    `ws://127.0.0.1:${options.port}/unexpected/test`,
    `ws://127.0.0.1:${options.port}/devtools/page/test?query=1`,
  ];
  for (const value of invalid) {
    let rejected = false;
    try { validatedDebuggerUrl({ webSocketDebuggerUrl: value }, options.port); } catch { rejected = true; }
    if (!rejected) throw new Error(`CDP URL validation accepted an unsafe URL: ${value}`);
  }
  const invalidBrowserUrls = [
    `ws://127.0.0.1:${options.port}/devtools/page/not-a-browser`,
    `ws://127.0.0.1:${options.port}/devtools/browser/bad%20id`,
    `ws://127.0.0.1:${options.port}/devtools/browser/test?query=1`,
  ];
  for (const value of invalidBrowserUrls) {
    let rejected = false;
    try { browserIdFromVersion({ webSocketDebuggerUrl: value }, options.port); } catch { rejected = true; }
    if (!rejected) throw new Error(`Browser identity validation accepted an unsafe URL: ${value}`);
  }
  const validPageTarget = {
    id: "page-test",
    type: "page",
    url: "app://codex/",
    webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/page/page-test`,
  };
  const invalidPageTargets = [
    { ...validPageTarget, webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser/page-test` },
    { ...validPageTarget, id: "other-page" },
    { ...validPageTarget, id: 123 },
    { ...validPageTarget, type: "other" },
  ];
  if (!valid || browserId !== "test-browser" || !isValidCdpPageTarget(validPageTarget, options.port) ||
      invalidPageTargets.some((item) => isValidCdpPageTarget(item, options.port))) {
    throw new Error("CDP URL and target validation self-test failed");
  }
  const validMessage = parseCdpMessage('{"id":7,"result":{"ok":true}}');
  const invalidMessages = ["{not-json", "null", '"text"', "42", "true"];
  if (validMessage?.id !== 7 || validMessage.result?.ok !== true ||
      invalidMessages.some((value) => parseCdpMessage(value) !== null)) {
    throw new Error("CDP message validation self-test failed");
  }
  if (/dispatchKeyEvent|dispatchMouseEvent/.test(capture.toString())) {
    throw new Error("Screenshot capture must not dispatch renderer input events");
  }
  console.log(JSON.stringify({ pass: true, version: SKIN_VERSION, test: "loopback-cdp-validation" }));
  } else if (options.mode === "check-payload") {
    const loaded = await loadPayload(options.themeDir, null, dynamicRuntimeForOptions(options));
    const unresolved = /__DREAM_SKIN_[A-Z0-9_]+_JSON__/.test(loaded.payload);
    if (unresolved) {
      throw new Error("Payload placeholders were not fully replaced");
    }
    console.log(JSON.stringify({
      pass: true,
      version: SKIN_VERSION,
      payloadBytes: Buffer.byteLength(loaded.payload),
      themeId: loaded.theme.id,
      appearance: loaded.theme.appearance,
      colorMode: loaded.theme.colorMode,
      explicitColorKeys: loaded.theme.explicitColorKeys,
      hasColors: !!loaded.theme.colors && typeof loaded.theme.colors === "object",
      hasPalette: Object.hasOwn(loaded.theme, "palette"),
      art: loaded.theme.art,
      artMetadata: loaded.theme.artMetadata ?? null,
      safeCssStatus: loaded.safeCssStatus,
    }));
  } else if (options.mode === "begin-operation") await runBeginOperation(options);
  else if (options.mode === "finish-operation") await runFinishOperation(options);
  else if (options.mode === "watch") await runWatch(options);
  else await runExclusiveOneShot(options);
}
