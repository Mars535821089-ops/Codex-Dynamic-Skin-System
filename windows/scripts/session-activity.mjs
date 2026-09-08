// Generated from macos/scripts/dream-skin-autostart.mjs by tools/sync-runtime-assets.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MAX_SESSION_TAIL_BYTES = 16 * 1024 * 1024;
const SESSION_CLOCK_TOLERANCE_MS = 2_000;
const ACTIVE_EVENT = "task_started";
const TERMINAL_EVENTS = new Set(["task_complete", "turn_aborted"]);

export function decidePlainLaunchCorrection(activity) {
  if (activity?.status === "idle" && activity?.activeCount === 0) {
    return { allowRestart: true, reason: "idle" };
  }
  if (activity?.status === "busy") {
    return { allowRestart: false, reason: "active-task" };
  }
  return { allowRestart: false, reason: "activity-unknown" };
}

async function collectSessionFiles(root, output) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("session-tree-symlink");
    if (entry.isDirectory()) await collectSessionFiles(target, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
  }
}

async function readSessionTail(filePath, size) {
  const length = Math.min(size, MAX_SESSION_TAIL_BYTES);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    let value = buffer.subarray(0, bytesRead).toString("utf8");
    const truncated = length < size;
    if (truncated) {
      const firstNewline = value.indexOf("\n");
      value = firstNewline >= 0 ? value.slice(firstNewline + 1) : "";
    }
    return { text: value, truncated };
  } finally {
    await handle.close();
  }
}

function lifecycleEvent(record, appStartedAtMs) {
  const type = record?.type === "event_msg" ? record?.payload?.type : record?.type;
  if (type !== ACTIVE_EVENT && !TERMINAL_EVENTS.has(type)) return null;
  const timestamp = Date.parse(record?.timestamp || "");
  if (!Number.isFinite(timestamp) || timestamp < appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) {
    return null;
  }
  return { type, timestamp };
}

export async function probeSessionActivity(sessionsRoot, appStartedAtMs) {
  if (!path.isAbsolute(sessionsRoot || "") || !Number.isFinite(appStartedAtMs)) {
    return { status: "unknown", activeCount: 0 };
  }
  try {
    const rootStat = await fs.lstat(sessionsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { status: "unknown", activeCount: 0 };
    }
    const files = [];
    await collectSessionFiles(sessionsRoot, files);
    let activeCount = 0;
    let uncertain = false;
    for (const filePath of files) {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        uncertain = true;
        continue;
      }
      if (stat.mtimeMs < appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) continue;
      const { text, truncated } = await readSessionTail(filePath, stat.size);
      let latest = null;
      let sawCurrentRecord = false;
      for (const line of text.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          uncertain = true;
          continue;
        }
        const recordTimestamp = Date.parse(record?.timestamp || "");
        if (!Number.isFinite(recordTimestamp)) {
          uncertain = true;
          continue;
        }
        if (recordTimestamp >= appStartedAtMs - SESSION_CLOCK_TOLERANCE_MS) {
          sawCurrentRecord = true;
        }
        const event = lifecycleEvent(record, appStartedAtMs);
        if (event && (!latest || event.timestamp >= latest.timestamp)) latest = event;
      }
      if (latest?.type === ACTIVE_EVENT) activeCount += 1;
      else if (!latest && (truncated || sawCurrentRecord)) uncertain = true;
    }
    if (activeCount > 0) return { status: "busy", activeCount };
    if (uncertain) return { status: "unknown", activeCount: 0 };
    return { status: "idle", activeCount: 0 };
  } catch {
    return { status: "unknown", activeCount: 0 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--sessions-root' || args[2] !== '--app-started-at-ms'
      || !Number.isFinite(Number(args[3]))) {
    console.error('Usage: session-activity.mjs --sessions-root <absolute-path> --app-started-at-ms <epoch-ms>');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await probeSessionActivity(args[1], Number(args[3]))));
  }
}
