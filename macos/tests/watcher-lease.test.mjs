import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  acquireWatcherLease,
  assertNoActiveWatcher,
} from "../scripts/watcher-lease.mjs";

const execFileAsync = promisify(execFile);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-watcher-lease-test-"));
try {
  const first = await acquireWatcherLease({ port: 19342, root });

  await assert.rejects(
    assertNoActiveWatcher({ port: 19342, root, operation: "one-shot injection" }),
    /PID \d+ already owns CDP port 19342.*one-shot injection/i,
    "A one-shot mutation must not overwrite a renderer owned by a live watcher.",
  );

  await assert.rejects(
    acquireWatcherLease({ port: 19342, root }),
    /already owns CDP port 19342/i,
    "A second watcher must not be allowed to control the same renderer port.",
  );

  const otherPort = await acquireWatcherLease({ port: 19343, root });
  await otherPort.release();

  await first.release();
  await assert.doesNotReject(assertNoActiveWatcher({ port: 19342, root }));
  const replacement = await acquireWatcherLease({ port: 19342, root });
  await replacement.release();

  const race = await Promise.allSettled([
    acquireWatcherLease({ port: 19344, root }),
    acquireWatcherLease({ port: 19344, root }),
  ]);
  const winners = race.filter((result) => result.status === "fulfilled");
  const losers = race.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1, "Exactly one concurrent watcher may win a port lease.");
  assert.equal(losers.length, 1, "The losing concurrent watcher must fail closed.");
  await winners[0].value.release();

  const reusedPidLock = path.join(root, "port-19345.lock");
  await fs.mkdir(reusedPidLock, { mode: 0o700 });
  await fs.writeFile(
    path.join(reusedPidLock, "owner.json"),
    `${JSON.stringify({
      schema: "codex-dream-skin-watcher-owner/3",
      pid: process.pid,
      port: 19345,
      token: "stale-owner-with-reused-pid",
      processStartedAt: "Mon Jan  1 00:00:00 1990",
      commandLine: `${process.execPath} ${process.argv[1]}`,
      nodePath: process.execPath,
      injectorPath: process.argv[1],
      createdAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  const reclaimed = await acquireWatcherLease({ port: 19345, root });
  assert.equal(
    reclaimed.owner.pid,
    process.pid,
    "A live but reused PID must not preserve a stale watcher lease.",
  );
  assert.notEqual(reclaimed.owner.token, "stale-owner-with-reused-pid");
  await reclaimed.release();

  const currentStartedAt = (await execFileAsync(
    "/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" },
  )).stdout.trim().replace(/\s+/g, " ");
  const mismatchedCommandLock = path.join(root, "port-19346.lock");
  await fs.mkdir(mismatchedCommandLock, { mode: 0o700 });
  await fs.writeFile(
    path.join(mismatchedCommandLock, "owner.json"),
    `${JSON.stringify({
      schema: "codex-dream-skin-watcher-owner/3",
      pid: process.pid,
      port: 19346,
      token: "stale-owner-with-lookalike-command",
      processStartedAt: currentStartedAt,
      commandLine: `/not-the-live-process/${path.basename(process.execPath)} /not-the-live-process/${path.basename(process.argv[1])}`,
      nodePath: `/not-the-live-process/${path.basename(process.execPath)}`,
      injectorPath: `/not-the-live-process/${path.basename(process.argv[1])}`,
      createdAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  const exactIdentity = await acquireWatcherLease({ port: 19346, root });
  assert.notEqual(exactIdentity.owner.token, "stale-owner-with-lookalike-command");
  await exactIdentity.release();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS: a CDP port has exactly one Dream Skin watcher owner.");
