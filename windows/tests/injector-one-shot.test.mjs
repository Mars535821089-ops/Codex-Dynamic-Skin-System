import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
const leaseIdentity = `dream-skin-one-shot-test-${process.pid}`;
const leaseRoot = path.join(os.tmpdir(), `codex-dream-skin-watchers-${leaseIdentity}`);
let versionRequests = 0;
let port = 0;

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/json/list") {
    response.end("[]");
    return;
  }
  if (request.url === "/json/version") {
    versionRequests += 1;
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-browser`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
port = server.address().port;

const runMode = (mode) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    injectorPath,
    mode,
    "--port", String(port),
    "--browser-id", "test-browser",
    "--timeout-ms", "250",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, USERNAME: leaseIdentity, USER: leaseIdentity },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});

try {
  for (const mode of ["--verify", "--once", "--remove"]) {
    const initializingLease = path.join(leaseRoot, `port-${port}.lock`);
    if (mode === "--once") await fs.mkdir(initializingLease, { recursive: true });
    const requestsBefore = versionRequests;
    const result = await runMode(mode);
    assert.notEqual(result.code, 0, `${mode} should time out because the fixture exposes no page targets.`);
    assert.ok(versionRequests > requestsBefore,
      `${mode} must validate its expected Browser ID before any mutation preflight.\n${result.stdout}\n${result.stderr}`);
    if (mode === "--once") await fs.rm(initializingLease, { recursive: true, force: true });
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /options is not defined/,
      `${mode} must not reference a CLI options binding outside its lexical scope.`);
  }
} finally {
  await fs.rm(leaseRoot, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}

console.log("PASS: Windows verify, once, and remove pass Browser ID explicitly into one-shot discovery.");
