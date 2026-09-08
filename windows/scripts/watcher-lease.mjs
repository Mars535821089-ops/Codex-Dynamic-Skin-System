import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const INITIALIZING_GRACE_MS = 5000;
const execFileAsync = promisify(execFile);

function defaultRoot() {
  const identity = process.env.USERNAME || process.env.USER || "user";
  const safeIdentity = identity.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "user";
  return path.join(os.tmpdir(), `codex-dream-skin-watchers-${safeIdentity}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function readProcessIdentity(pid, { platform = process.platform,
  execute = execFileAsync, isAlive = processIsAlive } = {}) {
  if (!isAlive(pid)) return null;
  try {
    if (platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
        `$q = Get-Process -Id ${pid} -ErrorAction Stop`,
        `if ($null -eq $p) { exit 3 }`,
        `[pscustomobject]@{ processStartedAt = $q.StartTime.ToUniversalTime().ToString('o'); executablePath = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress`,
      ].join("; ");
      const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32",
        "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = await execute(executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], { encoding: "utf8", timeout: 2000, windowsHide: true });
      const parsed = JSON.parse(result.stdout.trim());
      if (!parsed?.processStartedAt || !parsed?.commandLine) throw new Error("Incomplete process identity");
      return parsed;
    }
    const [started, command] = await Promise.all([
      execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1500,
      }),
      execute("/bin/ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8", timeout: 1500,
      }),
    ]);
    const processStartedAt = started.stdout.trim().replace(/\s+/g, " ");
    const commandLine = command.stdout.trim();
    if (!processStartedAt || !commandLine) throw new Error("Incomplete process identity");
    return { processStartedAt, executablePath: null, commandLine };
  } catch (error) {
    // A slow/denied CIM query is not proof the owner exited. Reclaiming the
    // lease here would permit concurrent watchers and recurring reinjection.
    if (isAlive(pid)) throw new Error(`Could not verify live watcher process identity: ${error.message}`);
    return null;
  }
}

function normalizedWindowsPath(value) {
  if (typeof value !== "string" || !value) return "";
  return path.win32.normalize(value).toLowerCase();
}

async function ownerStillMatches(owner, inspectProcess) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  const current = await inspectProcess(owner.pid);
  if (!current) return false;
  // A live legacy owner remains authoritative during an in-place upgrade.
  if (owner.schema !== "codex-dream-skin-watcher-owner/2") return true;
  if (current.processStartedAt !== owner.processStartedAt) return false;
  if (!owner.nodePath || !owner.injectorPath || !current.commandLine) return false;
  if (current.executablePath
      && normalizedWindowsPath(current.executablePath) !== normalizedWindowsPath(owner.nodePath)) {
    return false;
  }
  const command = current.commandLine.toLowerCase();
  return command.includes(String(owner.nodePath).toLowerCase())
    && command.includes(String(owner.injectorPath).toLowerCase());
}

async function secureRoot(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Watcher lease root is not a private directory: ${root}`);
  }
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value?.token === "string"
      ? value : null;
  } catch {
    return null;
  }
}

async function removeIfStale(lockPath, inspectProcess) {
  const owner = await readOwner(lockPath);
  if (owner && await ownerStillMatches(owner, inspectProcess)) return { removed: false, owner };
  const stat = await fs.lstat(lockPath).catch(() => null);
  if (!stat) return { removed: true, owner: null };
  if (!owner && Date.now() - stat.mtimeMs < INITIALIZING_GRACE_MS) {
    return { removed: false, owner: null };
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return { removed: true, owner };
}

export async function acquireWatcherLease({
  port,
  root = defaultRoot(),
  pid = process.pid,
  nodePath = process.execPath,
  injectorPath = process.argv[1] ? path.resolve(process.argv[1]) : "",
  inspectProcess = readProcessIdentity,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid watcher CDP port: ${port}`);
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !nodePath || !injectorPath
      || typeof inspectProcess !== "function") {
    throw new Error("Watcher lease requires a verifiable process identity");
  }
  await secureRoot(root);
  const lockPath = path.join(root, `port-${port}.lock`);
  const identity = await inspectProcess(pid);
  if (!identity?.processStartedAt || !identity?.commandLine) {
    throw new Error("Could not verify the watcher process identity before acquiring its lease");
  }
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      created = true;
      const owner = {
        schema: "codex-dream-skin-watcher-owner/2",
        pid,
        port,
        token,
        processStartedAt: identity.processStartedAt,
        nodePath,
        injectorPath,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      let released = false;
      return Object.freeze({
        owner,
        path: lockPath,
        async release() {
          if (released) return false;
          released = true;
          const current = await readOwner(lockPath);
          if (current?.token === token && current.pid === pid) {
            await fs.rm(lockPath, { recursive: true, force: true });
          }
          return true;
        },
      });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (created) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const state = await removeIfStale(lockPath, inspectProcess);
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
  inspectProcess = readProcessIdentity,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid watcher CDP port: ${port}`);
  }
  if (typeof operation !== "string" || !operation || operation.length > 80
      || typeof inspectProcess !== "function") {
    throw new Error("Watcher ownership check requires a short operation label");
  }
  await secureRoot(root);
  const state = await removeIfStale(path.join(root, `port-${port}.lock`), inspectProcess);
  if (state.removed) return true;
  const ownerLabel = state.owner?.pid ? `PID ${state.owner.pid}` : "another watcher";
  throw new Error(`${ownerLabel} already owns CDP port ${port}; refusing ${operation} outside the watcher`);
}
