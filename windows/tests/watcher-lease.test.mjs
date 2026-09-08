import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as leaseApi from "../scripts/watcher-lease.mjs";

import {
  acquireWatcherLease,
  assertNoActiveWatcher,
} from "../scripts/watcher-lease.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-lease-test-"));

test("one Windows CDP port has exactly one strict watcher owner", async (t) => {
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = {
    processStartedAt: "2026-09-05T01:02:03.0000000Z",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\skin\\injector.mjs" --watch',
  };
  const inspectProcess = async (pid) => pid === 1234 ? identity : null;
  const leaseOptions = {
    port: 19342,
    root,
    pid: 1234,
    nodePath: identity.executablePath,
    injectorPath: "C:\\skin\\injector.mjs",
    inspectProcess,
  };
  const first = await acquireWatcherLease(leaseOptions);

  await assert.rejects(
    assertNoActiveWatcher({ ...leaseOptions, operation: "one-shot injection" }),
    /PID 1234 already owns CDP port 19342.*one-shot injection/i,
  );
  await assert.rejects(acquireWatcherLease(leaseOptions), /already owns CDP port 19342/i);
  await first.release();
  await assert.doesNotReject(assertNoActiveWatcher({ ...leaseOptions, operation: "verification" }));
});

test("a reused Windows PID cannot preserve a stale watcher lease", async () => {
  const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-reused-pid-"));
  try {
    const lockPath = path.join(staleRoot, "port-19343.lock");
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      schema: "codex-dream-skin-watcher-owner/2",
      pid: 1234,
      port: 19343,
      token: "stale-owner",
      processStartedAt: "1990-01-01T00:00:00.0000000Z",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      injectorPath: "C:\\skin\\injector.mjs",
      createdAt: new Date(0).toISOString(),
    })}\n`);
    const currentIdentity = {
      processStartedAt: "2026-09-05T01:02:03.0000000Z",
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\skin\\injector.mjs" --watch',
    };
    const reclaimed = await acquireWatcherLease({
      port: 19343,
      root: staleRoot,
      pid: 1234,
      nodePath: currentIdentity.executablePath,
      injectorPath: "C:\\skin\\injector.mjs",
      inspectProcess: async () => currentIdentity,
    });
    assert.notEqual(reclaimed.owner.token, "stale-owner");
    assert.equal(reclaimed.owner.processStartedAt, currentIdentity.processStartedAt);
    await reclaimed.release();
  } finally {
    await fs.rm(staleRoot, { recursive: true, force: true });
  }
});

test("Windows process inspection fails closed while a live owner cannot be inspected", async () => {
  assert.equal(typeof leaseApi.readProcessIdentity, "function");
  await assert.rejects(leaseApi.readProcessIdentity(4321, { platform: "win32", isAlive: () => true,
    execute: async () => { throw new Error("CIM timed out"); } }), /live.*identity/i);
});

test("Windows process inspection explicitly requests UTF-8 for Chinese owner paths", async () => {
  assert.equal(typeof leaseApi.readProcessIdentity, "function");
  const identity = { processStartedAt: "2026-09-09T00:00:00Z", executablePath: "C:\\工具\\node.exe",
    commandLine: '"C:\\工具\\node.exe" "C:\\动态 主题\\injector.mjs" --watch' };
  const result = await leaseApi.readProcessIdentity(4321, { platform: "win32", isAlive: () => true,
    execute: async (executable, args) => {
      assert.match(executable, /System32[\\/]WindowsPowerShell/);
      assert.match(args.at(-1), /OutputEncoding.*UTF8Encoding/);
      return { stdout: JSON.stringify(identity) };
    } });
  assert.deepEqual(result, identity);
});
