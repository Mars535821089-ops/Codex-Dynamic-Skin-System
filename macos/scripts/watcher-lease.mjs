import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const INITIALIZING_GRACE_MS = 5000;
const execFileAsync = promisify(execFile);

function defaultRoot() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `codex-dream-skin-watchers-${uid}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readProcessIdentity(pid) {
  if (!processIsAlive(pid)) return null;
  try {
    const [started, command] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 1500,
      }),
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 1500,
      }),
    ]);
    const processStartedAt = started.stdout.trim().replace(/\s+/g, " ");
    const commandLine = command.stdout.trim();
    if (!processStartedAt || !commandLine) return null;
    return { processStartedAt, commandLine };
  } catch {
    return null;
  }
}

async function ownerStillMatches(owner) {
  if (!owner || !processIsAlive(owner.pid)) return false;
  // Preserve a live legacy lease while upgrading. New leases bind PID,
  // process start time, and the exact command line so PID reuse is stale.
  if (owner.schema !== "codex-dream-skin-watcher-owner/3") return true;
  const current = await readProcessIdentity(owner.pid);
  if (!current || current.processStartedAt !== owner.processStartedAt) return false;
  if (typeof owner.nodePath !== "string" || !owner.nodePath) return false;
  if (typeof owner.injectorPath !== "string" || !owner.injectorPath) return false;
  if (typeof owner.commandLine !== "string" || !owner.commandLine) return false;
  return current.commandLine === owner.commandLine;
}

async function secureRoot(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Watcher lease root is not a private directory: ${root}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Watcher lease root is not owned by the current user: ${root}`);
  }
  await fs.chmod(root, 0o700);
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || typeof value?.token !== "string") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function removeIfStale(lockPath) {
  const owner = await readOwner(lockPath);
  if (owner && await ownerStillMatches(owner)) return { removed: false, owner };

  const stat = await fs.lstat(lockPath).catch(() => null);
  if (!stat) return { removed: true, owner: null };
  if (!owner && Date.now() - stat.mtimeMs < INITIALIZING_GRACE_MS) {
    return { removed: false, owner: null };
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return { removed: true, owner };
}

export async function acquireWatcherLease({ port, root = defaultRoot() } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid watcher CDP port: ${port}`);
  }
  await secureRoot(root);
  const lockPath = path.join(root, `port-${port}.lock`);
  const token = randomUUID();
  const processIdentity = await readProcessIdentity(process.pid);
  if (!processIdentity) {
    throw new Error("Could not verify the watcher process identity before acquiring its lease");
  }
  const injectorPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!injectorPath) throw new Error("Could not resolve the watcher injector path");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      const owner = {
        schema: "codex-dream-skin-watcher-owner/3",
        pid: process.pid,
        port,
        token,
        processStartedAt: processIdentity.processStartedAt,
        commandLine: processIdentity.commandLine,
        nodePath: path.resolve(process.execPath),
        injectorPath,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let released = false;
      return {
        owner,
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          const current = await readOwner(lockPath);
          if (current?.token === token && current.pid === process.pid) {
            await fs.rm(lockPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const state = await removeIfStale(lockPath);
      if (state.removed) continue;
      const ownerLabel = state.owner?.pid ? `PID ${state.owner.pid}` : "another watcher";
      throw new Error(`${ownerLabel} already owns CDP port ${port}; refusing a competing theme watcher`);
    }
  }
  throw new Error(`Could not acquire the watcher lease for CDP port ${port}`);
}

export async function assertNoActiveWatcher({
  port,
  root = defaultRoot(),
  operation = "renderer mutation",
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid watcher CDP port: ${port}`);
  }
  if (typeof operation !== "string" || !operation || operation.length > 80) {
    throw new Error("Watcher ownership check requires a short operation label");
  }
  await secureRoot(root);
  const lockPath = path.join(root, `port-${port}.lock`);
  const state = await removeIfStale(lockPath);
  if (state.removed) return true;
  const ownerLabel = state.owner?.pid ? `PID ${state.owner.pid}` : "another watcher";
  throw new Error(
    `${ownerLabel} already owns CDP port ${port}; refusing ${operation} outside the watcher`,
  );
}
