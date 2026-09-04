#!/bin/bash
set -euo pipefail
export LC_ALL=C LANG=C LC_CTYPE=C
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO_ROOT="$(/usr/bin/git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)" || {
  /usr/bin/printf 'Release builds must run from a Git checkout.\n' >&2
  exit 1
}
[ "$ROOT" = "$REPO_ROOT/macos" ] || {
  /usr/bin/printf 'Unexpected release source directory: %s\n' "$ROOT" >&2
  exit 1
}
VERSION="$(/usr/bin/tr -d '[:space:]' < "$ROOT/VERSION")"
RELEASE_DIR="$ROOT/release"
ARCHIVE="$RELEASE_DIR/codex-dynamic-skin-system-v$VERSION.zip"
TMP="$(/usr/bin/mktemp -d /tmp/codex-dynamic-skin-release.XXXXXX)"
trap '/bin/rm -rf "$TMP"' EXIT
if [ "${1:-}" != "--skip-tests" ]; then "$ROOT/tests/run-tests.sh"; fi
/bin/mkdir -p "$TMP/codex-dynamic-skin-system" "$RELEASE_DIR"
TRACKED_COUNT=0
while IFS= read -r -d '' TRACKED_PATH; do
  case "$TRACKED_PATH" in
    macos/release/*) continue ;;
    macos/*) ;;
    *)
      /usr/bin/printf 'Refusing unexpected tracked path: %s\n' "$TRACKED_PATH" >&2
      exit 1
      ;;
  esac
  SOURCE_PATH="$REPO_ROOT/$TRACKED_PATH"
  [ -f "$SOURCE_PATH" ] && [ ! -L "$SOURCE_PATH" ] || {
    /usr/bin/printf 'Release input must be a regular tracked file: %s\n' "$TRACKED_PATH" >&2
    exit 1
  }
  RELATIVE_PATH="${TRACKED_PATH#macos/}"
  DESTINATION_PATH="$TMP/codex-dynamic-skin-system/$RELATIVE_PATH"
  /bin/mkdir -p "$(/usr/bin/dirname "$DESTINATION_PATH")"
  /bin/cp -p "$SOURCE_PATH" "$DESTINATION_PATH"
  TRACKED_COUNT=$((TRACKED_COUNT + 1))
done < <(/usr/bin/git -C "$REPO_ROOT" ls-files -z -- macos)
[ "$TRACKED_COUNT" -gt 0 ] || {
  /usr/bin/printf 'No tracked macOS release files were found.\n' >&2
  exit 1
}
/usr/bin/find "$TMP/codex-dynamic-skin-system" -type f \
  \( -name '.DS_Store' -o -name '._*' \) -delete
/bin/chmod 755 "$TMP/codex-dynamic-skin-system"/*.command
/bin/chmod 755 "$TMP/codex-dynamic-skin-system"/scripts/*.sh \
  "$TMP/codex-dynamic-skin-system"/tests/*.sh
/bin/rm -f "$ARCHIVE"
COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --keepParent --norsrc --noextattr \
  "$TMP/codex-dynamic-skin-system" "$ARCHIVE"
SHA256="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk '{print $1}')"
/usr/bin/printf '%s  %s\n' "$SHA256" "$(basename "$ARCHIVE")" > "$RELEASE_DIR/SHA256SUMS.txt"
/usr/bin/printf 'Created %s\nSHA-256 %s\n' "$ARCHIVE" "$SHA256"
