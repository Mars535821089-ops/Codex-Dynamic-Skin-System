#!/bin/bash

# Safely expand one declarative theme ZIP into an empty private staging folder.
# Package semantics and exact declared files are validated by the shared Node
# validator after this structure-only boundary succeeds.

set -euo pipefail

ARCHIVE="${1:-}"
DESTINATION="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
EXTRACT_ROOT=""
EXTRACT_ROOT_ID=""
DESTINATION_REAL=""
DESTINATION_ID=""
PUBLISHED=0

fail_extract() {
  printf 'ChatGPT Dream Skin: %s\n' "$*" >&2
  exit 1
}

cleanup_extract() {
  if [ -n "${EXTRACT_ROOT:-}" ] && [ -d "$EXTRACT_ROOT" ] && [ ! -L "$EXTRACT_ROOT" ] \
      && [ "$(/usr/bin/stat -f '%d:%i' "$EXTRACT_ROOT" 2>/dev/null || true)" = "$EXTRACT_ROOT_ID" ]; then
    /bin/rm -rf "$EXTRACT_ROOT"
  fi
  if [ "$PUBLISHED" -eq 0 ] && [ -n "${DESTINATION_REAL:-}" ] \
      && [ -d "$DESTINATION_REAL" ] && [ ! -L "$DESTINATION_REAL" ] \
      && [ "$(/usr/bin/stat -f '%d:%i' "$DESTINATION_REAL" 2>/dev/null || true)" = "$DESTINATION_ID" ]; then
    /usr/bin/find "$DESTINATION_REAL" -xdev -mindepth 1 -delete 2>/dev/null || true
  fi
}
trap cleanup_extract EXIT

[ -n "$ARCHIVE" ] && [ -n "$DESTINATION" ] \
  || fail_extract "Usage: extract-theme-zip-macos.sh <theme.zip> <empty-stage-dir>"
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || fail_extract "Theme ZIP must be a regular file: $ARCHIVE"
case "$(/usr/bin/basename "$ARCHIVE" | /usr/bin/tr '[:upper:]' '[:lower:]')" in
  *.zip) ;;
  *) fail_extract "Only ordinary .zip theme packages are supported; .dreamskin files are not accepted." ;;
esac
[ -d "$DESTINATION" ] && [ ! -L "$DESTINATION" ] || fail_extract "Theme import stage must be a real directory."
DESTINATION_REAL="$(cd "$DESTINATION" && pwd -P)"
DESTINATION_ID="$(/usr/bin/stat -f '%d:%i' "$DESTINATION_REAL")"
[ -z "$(/usr/bin/find "$DESTINATION_REAL" -mindepth 1 -print -quit)" ] || fail_extract "Theme import stage must be empty."

NODE_BIN="${DREAMSKIN_NODE:-${NODE:-}}"
if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"; fi
[ -x "$NODE_BIN" ] || fail_extract "A trusted Node.js runtime is required for ZIP preflight."
PREFLIGHT="$SCRIPT_DIR/../assets/dynamic/zip-preflight.mjs"
[ -f "$PREFLIGHT" ] || fail_extract "ZIP preflight helper is missing from the installed engine."
"$NODE_BIN" "$PREFLIGHT" "$ARCHIVE" >/dev/null

destination_parent="$(cd "$(dirname "$DESTINATION_REAL")" && pwd -P)"
EXTRACT_ROOT="$(/usr/bin/mktemp -d "$destination_parent/.theme-zip-extract.XXXXXX")"
/bin/chmod 700 "$EXTRACT_ROOT"
EXTRACT_ROOT_ID="$(/usr/bin/stat -f '%d:%i' "$EXTRACT_ROOT")"

# Central-directory metadata has already bounded every regular entry. bsdtar's
# safe defaults reject traversal and extraction through links; -k prevents one
# archive member from replacing another even if libarchive disagrees on names.
LC_ALL=C /usr/bin/tar -x --safe-writes --no-same-owner --no-same-permissions -k \
  -f "$ARCHIVE" -C "$EXTRACT_ROOT" </dev/null >/dev/null \
  || fail_extract "ZIP_INVALID: archive content is damaged or unsafe"

[ -z "$(/usr/bin/find "$EXTRACT_ROOT" -xdev -type l -print -quit)" ] || fail_extract "ZIP_ENTRY_TYPE: symbolic link extracted"
[ -z "$(/usr/bin/find "$EXTRACT_ROOT" -xdev ! -type d ! -type f -print -quit)" ] || fail_extract "ZIP_ENTRY_TYPE: unsupported filesystem entry extracted"

# Finder transport metadata is not theme content.
/bin/rm -rf "$EXTRACT_ROOT/__MACOSX"
/usr/bin/find "$EXTRACT_ROOT" -xdev -type f -name '.DS_Store' -delete

CONTRACT_JSON="$SCRIPT_DIR/../assets/dynamic/theme-contract.json"
limit_values="$("$NODE_BIN" -e '
  const fs = require("node:fs");
  const limits = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["x-limits"];
  const values = [limits?.zipEntries, limits?.zipExpandedBytes, limits?.singleEntryBytes];
  if (!values.every(Number.isSafeInteger) || values.some((value) => value < 1)) process.exit(2);
  process.stdout.write(values.join(" "));
' "$CONTRACT_JSON")" || fail_extract "CONTRACT_INVALID: ZIP limits could not be loaded"
read -r MAX_ENTRIES MAX_EXPANDED_BYTES MAX_ENTRY_BYTES <<EOF
$limit_values
EOF

actual_count=0
actual_bytes=0
while IFS= read -r -d '' entry; do
  relative="${entry#"$EXTRACT_ROOT"/}"
  resolved_parent="$(cd "$(dirname "$entry")" && pwd -P)" \
    || fail_extract "ASSET_PATH: extracted entry parent could not be resolved"
  resolved="$resolved_parent/$(/usr/bin/basename "$entry")"
  case "$resolved" in "$EXTRACT_ROOT"|"$EXTRACT_ROOT"/*) ;; *) fail_extract "ASSET_PATH: extracted entry escaped staging" ;; esac
  if [ -f "$entry" ]; then
    actual_count=$((actual_count + 1))
    [ "$actual_count" -le "$MAX_ENTRIES" ] || fail_extract "ZIP_LIMIT: extracted file count exceeds contract"
    entry_links="$(/usr/bin/stat -f '%l' "$entry")"
    [ "$entry_links" -eq 1 ] || fail_extract "ZIP_ENTRY_TYPE: hard-linked files are forbidden"
    entry_bytes="$(/usr/bin/stat -f '%z' "$entry")"
    [ "$entry_bytes" -le "$MAX_ENTRY_BYTES" ] || fail_extract "ZIP_LIMIT: extracted entry exceeds contract"
    actual_bytes=$((actual_bytes + entry_bytes))
    [ "$actual_bytes" -le "$MAX_EXPANDED_BYTES" ] || fail_extract "ZIP_LIMIT: extracted bytes exceed contract"
    case "$(LC_ALL=C /usr/bin/printf '%s' "$relative" | /usr/bin/tr '[:upper:]' '[:lower:]')" in
      *.zip|*.dreamskin|*.7z|*.rar|*.tar|*.tar.gz|*.tgz|*.gz|*.bz2|*.xz)
        fail_extract "ZIP_NESTED: nested compressed archives are forbidden"
        ;;
    esac
  fi
done < <(/usr/bin/find "$EXTRACT_ROOT" -xdev -mindepth 1 -print0)

SOURCE_ROOT=""
if [ -f "$EXTRACT_ROOT/theme.json" ]; then
  SOURCE_ROOT="$EXTRACT_ROOT"
else
  top_count=0
  while IFS= read -r -d '' item; do
    top_count=$((top_count + 1))
    if [ -d "$item" ] && [ -f "$item/theme.json" ]; then SOURCE_ROOT="$item"; fi
  done < <(/usr/bin/find "$EXTRACT_ROOT" -xdev -mindepth 1 -maxdepth 1 -print0)
  [ "$top_count" -eq 1 ] && [ -n "$SOURCE_ROOT" ] \
    || fail_extract "Theme ZIP must contain theme.json at root or in one top-level folder."
fi

[ "$(/usr/bin/stat -f '%d:%i' "$DESTINATION_REAL" 2>/dev/null || true)" = "$DESTINATION_ID" ] \
  || fail_extract "Theme import stage identity changed during extraction."
/bin/cp -R "$SOURCE_ROOT/." "$DESTINATION_REAL/" \
  || fail_extract "Theme ZIP could not be copied into the import stage."
/bin/chmod -R u=rwX,go= "$DESTINATION_REAL"
PUBLISHED=1

trap - EXIT
/bin/rm -rf "$EXTRACT_ROOT"
EXTRACT_ROOT=""
