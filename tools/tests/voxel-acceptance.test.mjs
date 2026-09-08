import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(projectRoot, "tools", "voxel-acceptance.mjs");

async function createSilentWebSocketServer() {
  const server = http.createServer();
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const accept = crypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    destroySockets() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

test("CLI records a machine-readable skipped prerequisite when no isolated CDP endpoint is supplied", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "voxel-acceptance-test."));
  const reportPath = path.join(output, "report.json");
  const result = spawnSync(process.execPath, [cliPath, "--report", reportPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.deepEqual(report, {
    schemaVersion: 1,
    status: "skipped-prerequisite",
    reason: "isolated-cdp-required",
  });
});

test("frame-time summary reports hand-checked percentiles and rejects invalid samples", async () => {
  const { summarizeFrameTimes } = await import("../voxel-acceptance.mjs");
  assert.deepEqual(summarizeFrameTimes([40, 10, 30, 20, NaN, -1]), {
    count: 4,
    p50Ms: 25,
    p95Ms: 38.5,
    maxMs: 40,
  });
});

test("acceptance options bound signal mode, tier, frame count, and viewport", async () => {
  const { parseAcceptanceArgs } = await import("../voxel-acceptance.mjs");
  assert.deepEqual(parseAcceptanceArgs([
    "--mode", "sweep", "--tier", "balanced", "--frames", "600",
    "--viewport", "2560x1440", "--reduced-motion", "--cdp-port", "19342",
    "--report", "work/report.json",
  ]), {
    mode: "sweep",
    tier: "balanced",
    frames: 600,
    viewport: { width: 2560, height: 1440 },
    reducedMotion: true,
    cdpPort: 19342,
    reportPath: path.resolve(projectRoot, "work/report.json"),
  });
  assert.throws(() => parseAcceptanceArgs(["--mode", "noise"]), /mode/i);
  assert.throws(() => parseAcceptanceArgs(["--frames", "0"]), /frames/i);
  assert.throws(() => parseAcceptanceArgs(["--viewport", "99x99"]), /viewport/i);
});

test("voxel CDP commands reject when a connected renderer never answers", async () => {
  const { Cdp } = await import("../voxel-acceptance.mjs");
  assert.equal(typeof Cdp, "function", "voxel acceptance must expose its bounded CDP session");
  const fixture = await createSilentWebSocketServer();
  const { server } = fixture;
  const address = server.address();
  const cdp = new Cdp(`ws://127.0.0.1:${address.port}/devtools/page/silent`);
  try {
    await cdp.open(1_000);
    await assert.rejects(
      cdp.call("Runtime.enable", {}, 200),
      /CDP command timed out: Runtime\.enable/,
    );
  } finally {
    cdp.close();
    fixture.destroySockets();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("voxel CDP discovery rejects when a loopback HTTP endpoint never answers", async () => {
  const { fetchJson } = await import("../voxel-acceptance.mjs");
  assert.equal(typeof fetchJson, "function", "voxel acceptance must expose bounded CDP HTTP reads");
  const server = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    await assert.rejects(
      fetchJson(`http://127.0.0.1:${address.port}/json/version`, undefined, 50),
      /CDP HTTP request timed out/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
