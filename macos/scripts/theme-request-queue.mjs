const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const GENERATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateThemeRequest(value, {
  currentThemeId,
  currentRevision,
  lastSequence = 0,
  now = Date.now(),
  maxAgeMs = 5_000,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, fromThemeId, generation, issuedAt, sequence } = value;
  if (typeof id !== "string" || !THEME_ID_PATTERN.test(id)
    || typeof fromThemeId !== "string" || fromThemeId !== currentThemeId
    || typeof generation !== "string" || generation !== currentRevision
    || !GENERATION_PATTERN.test(generation)
    || !Number.isFinite(issuedAt) || issuedAt < now - maxAgeMs || issuedAt > now + 1_000
    || !Number.isSafeInteger(sequence) || sequence <= lastSequence) return null;
  return { id, fromThemeId, generation, issuedAt, sequence };
}

export function selectLatestThemeRequest(values) {
  let selected = null;
  for (const [index, value] of values.entries()) {
    const request = typeof value === "string"
      ? { id: value, issuedAt: 0, sequence: index }
      : value && typeof value === "object" && typeof value.id === "string"
        ? {
            id: value.id,
            fromThemeId: value.fromThemeId,
            generation: value.generation,
            issuedAt: Number.isFinite(value.issuedAt) ? value.issuedAt : 0,
            sequence: Number.isFinite(value.sequence) ? value.sequence : index,
          }
        : null;
    if (!request) continue;
    if (!selected || request.issuedAt > selected.issuedAt
      || (request.issuedAt === selected.issuedAt && request.sequence >= selected.sequence)) {
      selected = request;
    }
  }
  return selected;
}

export function createLatestThemeRequestQueue({ apply, settleMs = 160, onError = () => {} }) {
  if (typeof apply !== "function") throw new TypeError("apply must be a function");
  let pending = null;
  let revision = 0;
  let timer = null;
  let resolveTimer = null;
  let draining = null;
  let closed = false;

  const waitForQuietPeriod = async () => {
    while (!closed && pending) {
      const observedRevision = revision;
      await new Promise((resolve) => {
        resolveTimer = resolve;
        timer = setTimeout(resolve, settleMs);
      });
      timer = null;
      resolveTimer = null;
      if (observedRevision === revision) return;
    }
  };

  const drain = () => {
    if (closed || draining) return draining;
    draining = (async () => {
      await waitForQuietPeriod();
      while (!closed && pending) {
        const request = pending;
        pending = null;
        try {
          await apply(request);
        } catch (error) {
          onError(error, request);
        }
        if (pending) await waitForQuietPeriod();
      }
    })().finally(() => {
      draining = null;
      if (!closed && pending) drain();
    });
    return draining;
  };

  return {
    request(value) {
      if (closed || !value) return false;
      pending = value;
      revision += 1;
      drain();
      return true;
    },
    clear() {
      pending = null;
      revision += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        resolveTimer?.();
        resolveTimer = null;
      }
    },
    async idle() {
      await draining;
    },
    close() {
      closed = true;
      this.clear();
    },
  };
}
