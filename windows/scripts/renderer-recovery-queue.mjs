export function createRendererRecoveryQueue({
  isCurrent,
  recover,
  onFailure = async () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (![isCurrent, recover, onFailure, setTimer, clearTimer]
    .every((value) => typeof value === "function")) {
    throw new TypeError("renderer recovery queue callbacks must be functions");
  }

  let closed = false;
  let pending = false;
  let timer = null;
  let chain = Promise.resolve();
  let scheduled = Promise.resolve();
  let finishScheduled = null;

  const request = (reason, { delayMs = 0 } = {}) => {
    if (closed || pending || !isCurrent()) return false;
    if (typeof reason !== "string" || !reason || reason.length > 120) {
      throw new TypeError("renderer recovery reason must be a short string");
    }
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30_000) {
      throw new TypeError("renderer recovery delay must be between 0 and 30000ms");
    }
    pending = true;
    scheduled = new Promise((resolve) => { finishScheduled = resolve; });
    timer = setTimer(() => {
      timer = null;
      const operation = chain.then(async () => {
        if (closed || !isCurrent()) return false;
        await recover(reason);
        return true;
      });
      chain = operation.catch((error) => onFailure(error, reason)).finally(() => {
        pending = false;
        finishScheduled?.();
        finishScheduled = null;
      });
    }, delayMs);
    return true;
  };

  return Object.freeze({
    request,
    pending: () => pending,
    async idle() {
      await scheduled;
      await chain;
    },
    async close() {
      closed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
        pending = false;
        finishScheduled?.();
        finishScheduled = null;
      }
      await scheduled;
      await chain;
    },
  });
}
