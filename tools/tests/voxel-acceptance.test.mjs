import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(projectRoot, "tools", "voxel-acceptance.mjs");

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
