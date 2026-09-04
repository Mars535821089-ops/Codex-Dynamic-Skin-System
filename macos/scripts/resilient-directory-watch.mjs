import { watch as watchDirectoryDefault } from "node:fs";

export function createResilientDirectoryWatch({
  directory,
  recursive = false,
  onEvent,
  onError = () => {},
  watchDirectory = watchDirectoryDefault,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = 1000,
} = {}) {
  if (typeof directory !== "string" || !directory) {
    throw new TypeError("watch directory must be a non-empty string");
  }
  if (typeof recursive !== "boolean") {
    throw new TypeError("watch recursive flag must be a boolean");
  }
  if (typeof onEvent !== "function" || typeof onError !== "function"
    || typeof watchDirectory !== "function" || typeof setTimer !== "function"
    || typeof clearTimer !== "function") {
    throw new TypeError("directory watch callbacks must be functions");
  }
  if (!Number.isFinite(retryMs) || retryMs < 100 || retryMs > 30_000) {
    throw new TypeError("directory watch retry delay must be between 100 and 30000ms");
  }

  let closed = false;
  let watcher = null;
  let retryTimer = null;

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      start();
    }, retryMs);
    retryTimer?.unref?.();
  };

  const start = () => {
    if (closed || watcher) return;
    let candidate;
    try {
      candidate = watchDirectory(directory, { persistent: false, recursive }, (...args) => {
        if (!closed && watcher === candidate) onEvent(...args);
      });
      watcher = candidate;
      candidate.on("error", (error) => {
        if (closed || watcher !== candidate) return;
        watcher = null;
        try { candidate.close(); } catch {}
        onError(error);
        scheduleRetry();
      });
      candidate.on("close", () => {
        if (closed || watcher !== candidate) return;
        watcher = null;
        scheduleRetry();
      });
    } catch (error) {
      onError(error);
      scheduleRetry();
    }
  };

  start();
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      const active = watcher;
      watcher = null;
      try { active?.close(); } catch {}
    },
  });
}
