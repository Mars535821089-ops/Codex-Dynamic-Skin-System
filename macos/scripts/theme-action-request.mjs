import { validateDynamicSettings } from "../assets/dynamic/settings.mjs";

const ACTIONS = new Set(["import-media", "delete-theme", "save-settings", "change-storage",
  "restore-default-theme"]);
const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const GENERATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateThemeActionRequest(value, {
  currentThemeId,
  currentRevision,
  lastSequence = 0,
  now = Date.now(),
  maxAgeMs = 5_000,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { action, themeId, generation, issuedAt, sequence } = value;
  if (!ACTIONS.has(action)
    || typeof themeId !== "string" || !THEME_ID_PATTERN.test(themeId) || themeId !== currentThemeId
    || typeof generation !== "string" || !GENERATION_PATTERN.test(generation) || generation !== currentRevision
    || !Number.isFinite(issuedAt) || issuedAt < now - maxAgeMs || issuedAt > now + 1_000
    || !Number.isSafeInteger(sequence) || sequence <= lastSequence) return null;
  if (action === "save-settings") {
    try {
      return { action, themeId, generation, issuedAt, sequence, settings: validateDynamicSettings(value.settings) };
    } catch {
      return null;
    }
  }
  if (action === "delete-theme") {
    const targetThemeId = value.targetThemeId;
    if (typeof targetThemeId !== "string" || !THEME_ID_PATTERN.test(targetThemeId)) return null;
    return { action, themeId, targetThemeId, generation, issuedAt, sequence };
  }
  return { action, themeId, generation, issuedAt, sequence };
}

export function selectLatestThemeActionRequest(values) {
  let selected = null;
  for (const value of values) {
    if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) continue;
    if (!selected || value.issuedAt > selected.issuedAt
      || (value.issuedAt === selected.issuedAt && value.sequence >= selected.sequence)) {
      selected = value;
    }
  }
  return selected;
}
