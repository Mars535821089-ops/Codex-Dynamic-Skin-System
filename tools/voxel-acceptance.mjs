#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const MODES = new Set(["silence", "bass", "mid", "treble", "sweep"]);
const TIERS = new Set(["full", "balanced", "media", "static"]);

export function parseAcceptanceArgs(argv) {
  const options = {
    mode: "sweep", tier: "full", frames: 600, viewport: { width: 1280, height: 800 },
    reducedMotion: false, cdpPort: null, reportPath: path.join(projectRoot, "work", "voxel-report.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reduced-motion") options.reducedMotion = true;
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--tier") options.tier = argv[++index];
    else if (arg === "--frames") options.frames = Number(argv[++index]);
    else if (arg === "--cdp-port") options.cdpPort = Number(argv[++index]);
    else if (arg === "--report") options.reportPath = path.resolve(projectRoot, argv[++index]);
    else if (arg === "--viewport") {
      const match = /^(\d+)x(\d+)$/.exec(argv[++index] || "");
      options.viewport = match ? { width: Number(match[1]), height: Number(match[2]) } : null;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!MODES.has(options.mode)) throw new Error("mode must be silence, bass, mid, treble, or sweep");
  if (!TIERS.has(options.tier)) throw new Error("tier must be full, balanced, media, or static");
  if (!Number.isInteger(options.frames) || options.frames < 1 || options.frames > 3600) throw new Error("frames must be 1..3600");
  if (!options.viewport || options.viewport.width < 320 || options.viewport.height < 240
    || options.viewport.width > 7680 || options.viewport.height > 4320) throw new Error("viewport is outside 320x240..7680x4320");
  if (options.cdpPort !== null && (!Number.isInteger(options.cdpPort) || options.cdpPort < 1024 || options.cdpPort > 65535)) {
    throw new Error("cdp port must be 1024..65535");
  }
  return options;
}

export function summarizeFrameTimes(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (p) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position); const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertIsolatedCdp(port) {
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  const pids = [...new Set(stdout.split(/\r?\n/).filter((line) => /^p\d+$/.test(line)).map((line) => line.slice(1)))];
  const commands = await Promise.all(pids.map(async (pid) => ({
    pid: Number(pid),
    command: (await execFileAsync("/bin/ps", ["-p", pid, "-o", "command="])).stdout.trim(),
  })));
  const explicitOwners = commands.filter(({ command }) => command.includes(`--remote-debugging-port=${port}`)
    && /--user-data-dir=(?:[^ ]+|"[^"]+")/.test(command));
  if (explicitOwners.length !== 1) {
    throw new Error("refusing CDP endpoint without an explicit isolated user-data-dir");
  }
  return { pid: explicitOwners[0].pid };
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  async open() {
    await Promise.race([
      new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("CDP WebSocket timeout")), 5000)),
    ]);
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.socket.close(); }
}

async function localServer() {
  const files = new Map([
    ["/", path.join(projectRoot, "tools", "voxel-acceptance.html")],
    ["/runtime/module-registry.js", path.join(projectRoot, "runtime", "dynamic", "browser", "module-registry.js")],
    ["/runtime/voxel-field.js", path.join(projectRoot, "runtime", "dynamic", "browser", "voxel-field.js")],
  ]);
  const server = http.createServer(async (request, response) => {
    const file = files.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!file) { response.writeHead(404).end(); return; }
    try { response.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(await fs.readFile(file)); }
    catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "page evaluation failed");
  return result.result?.value;
}

async function capture(cdp, file) {
  const { data } = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const buffer = Buffer.from(data, "base64");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, buffer);
  return { path: file, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

async function run(options) {
  const owner = await assertIsolatedCdp(options.cdpPort);
  const local = await localServer();
  let target = null; let cdp = null;
  const base = path.join(path.dirname(options.reportPath), `${path.basename(options.reportPath, path.extname(options.reportPath))}-screens`);
  try {
    const targetUrl = `http://127.0.0.1:${local.port}/`;
    target = await fetchJson(`http://127.0.0.1:${options.cdpPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
    cdp = new Cdp(target.webSocketDebuggerUrl); await cdp.open();
    await cdp.call("Page.enable"); await cdp.call("Runtime.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: 1, mobile: false });
    for (let retry = 0; retry < 50; retry += 1) {
      if (await evaluate(cdp, "typeof globalThis.__startVoxelAcceptance === 'function'")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await evaluate(cdp, `globalThis.__startVoxelAcceptance(${JSON.stringify(options)})`, true);
    const checkpoints = [...new Set([1, Math.max(1, Math.floor(options.frames / 2)), options.frames])];
    const screenshots = [];
    const deadline = Date.now() + Math.max(15000, options.frames * 100);
    for (const checkpoint of checkpoints) {
      let snapshot;
      do {
        snapshot = await evaluate(cdp, "globalThis.__voxelAcceptanceSnapshot()");
        if (snapshot.sampleCount >= checkpoint) break;
        if (Date.now() > deadline) throw new Error(`timed out at frame checkpoint ${checkpoint}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (true);
      screenshots.push({ checkpoint, ...await capture(cdp, path.join(base, `frame-${checkpoint}.png`)) });
    }
    const final = await evaluate(cdp, "globalThis.__finishVoxelAcceptance()", true);
    const report = {
      schemaVersion: 1, status: "passed", isolatedPid: owner.pid, mode: options.mode, tier: options.tier,
      reducedMotion: options.reducedMotion, viewport: options.viewport,
      frameTimes: summarizeFrameTimes(final.frameTimes), tierTransitions: final.tierTransitions,
      contextErrors: final.contextErrors, screenshots,
      resources: { ...final.resources, balanced: Object.keys(final.resources.created).every((key) => final.resources.created[key] === (final.resources.deleted[key] || 0)) },
      diagnostics: final.diagnostics,
    };
    await writeJson(options.reportPath, report); return report;
  } finally {
    cdp?.close();
    if (target?.id) await fetch(`http://127.0.0.1:${options.cdpPort}/json/close/${target.id}`).catch(() => {});
    await new Promise((resolve) => local.server.close(resolve));
  }
}

async function main() {
  let options;
  try { options = parseAcceptanceArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  if (options.cdpPort === null) {
    await writeJson(options.reportPath, { schemaVersion: 1, status: "skipped-prerequisite", reason: "isolated-cdp-required" });
    process.exitCode = 2; return;
  }
  try { const report = await run(options); console.log(JSON.stringify(report, null, 2)); }
  catch (error) {
    await writeJson(options.reportPath, { schemaVersion: 1, status: "failed", reason: error.message });
    console.error(error.stack || error.message); process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
