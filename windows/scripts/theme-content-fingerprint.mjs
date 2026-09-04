import { createHash } from "node:crypto";

function updateFramed(hash, label, bytes) {
  const labelBytes = Buffer.from(label, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(labelBytes).update("\0").update(length).update(bytes);
}

export function runtimeThemeContentFingerprint(theme, imageBytes, cssBytes = null) {
  const hash = createHash("sha256");
  hash.update("dreamskin-runtime-theme/1\0");
  updateFramed(hash, "theme.json", Buffer.from(JSON.stringify(theme), "utf8"));
  updateFramed(hash, "image", imageBytes);
  if (cssBytes) {
    updateFramed(hash, "theme.css", cssBytes);
  } else {
    hash.update("theme.css\0absent\0");
  }
  return hash.digest("hex");
}

function updateCanonicalLength(hash, value) {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  hash.update(bytes);
}

function updateCanonicalString(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  hash.update(Buffer.from([4]));
  updateCanonicalLength(hash, bytes.length);
  hash.update(bytes);
}

function updateCanonicalJsonValue(hash, value) {
  if (value === null) {
    hash.update(Buffer.from([0]));
  } else if (value === false) {
    hash.update(Buffer.from([1]));
  } else if (value === true) {
    hash.update(Buffer.from([2]));
  } else if (typeof value === "number") {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value);
    hash.update(Buffer.from([3])).update(bytes);
  } else if (typeof value === "string") {
    updateCanonicalString(hash, value);
  } else if (Array.isArray(value)) {
    hash.update(Buffer.from([5]));
    updateCanonicalLength(hash, value.length);
    for (const item of value) updateCanonicalJsonValue(hash, item);
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    hash.update(Buffer.from([6]));
    updateCanonicalLength(hash, keys.length);
    for (const key of keys) {
      updateCanonicalString(hash, key);
      updateCanonicalJsonValue(hash, value[key]);
    }
  } else {
    throw new TypeError("Theme JSON contains a value that cannot be canonicalized");
  }
}

export function runtimeThemeTreeFingerprint(theme, files, { includeId = true } = {}) {
  const semanticTheme = { ...theme };
  if (!includeId) delete semanticTheme.id;
  const hash = createHash("sha256").update(
    includeId ? "dreamskin-runtime-tree/2\0" : "dreamskin-semantic-tree/2\0",
    "utf8",
  );
  updateCanonicalJsonValue(hash, semanticTheme);
  for (const [fileName, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    if (fileName === "theme.json") continue;
    updateCanonicalString(hash, fileName);
    updateCanonicalLength(hash, bytes.length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
