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
  for (const value of values) {
    if (!value) continue;
    if (!selected || value.issuedAt > selected.issuedAt
      || (value.issuedAt === selected.issuedAt && value.sequence >= selected.sequence)) {
      selected = value;
    }
  }
  return selected;
}
