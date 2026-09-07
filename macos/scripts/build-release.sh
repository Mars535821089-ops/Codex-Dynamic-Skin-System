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
NODE="$(command -v node)" || {
  /usr/bin/printf 'Node.js is required to verify the public release boundary.\n' >&2
  exit 1
}
VERSION="$(/usr/bin/tr -d '\r\n' < "$ROOT/VERSION")"
if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  /usr/bin/printf 'macos/VERSION must contain a three-part semantic version: %s\n' "$VERSION" >&2
  exit 1
fi
"$NODE" "$REPO_ROOT/tools/verify-release-versions.mjs" --root "$REPO_ROOT" >/dev/null
# These are release-integrity gates, not optional regression tests. Keep them
# active even for --skip-tests so a manual build cannot package tracked private
# content or stale generated runtime assets.
"$NODE" "$REPO_ROOT/tools/verify-public-boundary.mjs" --root "$REPO_ROOT" >/dev/null
"$NODE" "$REPO_ROOT/tools/sync-runtime-assets.mjs" --check >/dev/null
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
INSTALL_MANIFEST_TMP="$TMP/INSTALL-FILES.txt"
(
  cd "$TMP/codex-dynamic-skin-system"
  {
    /usr/bin/find . -type f ! -name 'INSTALL-FILES.txt' -print \
      | /usr/bin/sed 's#^\./##'
    /usr/bin/printf 'INSTALL-FILES.txt\n'
  } | LC_ALL=C /usr/bin/sort > "$INSTALL_MANIFEST_TMP"
)
if ! /usr/bin/cmp -s "$INSTALL_MANIFEST_TMP" \
  "$TMP/codex-dynamic-skin-system/INSTALL-FILES.txt"; then
  /usr/bin/printf 'macOS install file manifest is stale; update macos/INSTALL-FILES.txt.\n' >&2
  exit 1
fi
/bin/rm -f "$INSTALL_MANIFEST_TMP"
/usr/bin/find "$TMP/codex-dynamic-skin-system" -type f \
  \( -name '.DS_Store' -o -name '._*' \) -delete
/bin/chmod 755 "$TMP/codex-dynamic-skin-system"/*.command
/bin/chmod 755 "$TMP/codex-dynamic-skin-system"/scripts/*.sh \
  "$TMP/codex-dynamic-skin-system"/tests/*.sh
# ZIP stores filesystem mtimes, including freshly-created directory mtimes. Use
# one fixed, ZIP-safe timestamp so identical tracked bytes produce identical
# release bytes across checkouts that only differ in filesystem mtimes.
/usr/bin/find "$TMP/codex-dynamic-skin-system" -depth -exec \
  /usr/bin/touch -h -t 200001010000 {} +
/bin/rm -f "$ARCHIVE"
COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --keepParent --norsrc --noextattr \
  "$TMP/codex-dynamic-skin-system" "$ARCHIVE"
SHA256="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk '{print $1}')"
/usr/bin/printf '%s  %s\n' "$SHA256" "$(basename "$ARCHIVE")" > "$RELEASE_DIR/SHA256SUMS.txt"
/usr/bin/printf 'Created %s\nSHA-256 %s\n' "$ARCHIVE" "$SHA256"
