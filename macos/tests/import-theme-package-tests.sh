#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
NODE_BIN="${NODE:-/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node}"
[ -x "$NODE_BIN" ] || { printf 'Codex bundled Node.js was not found: %s\n' "$NODE_BIN" >&2; exit 1; }
TMP="$(/usr/bin/mktemp -d /tmp/codex-dynamic-skin-v2-import.XXXXXX)"
trap '/bin/rm -rf "$TMP"' EXIT

make_archive() {
  local name="$1"
  local mode="$2"
  local source
  source="$("$NODE_BIN" "$ROOT/tests/helpers/make-v2-import-fixture.mjs" "$TMP" "$name" "$mode")"
  (
    cd "$source"
    /usr/bin/zip -qr "$TMP/$name.zip" .
  )
}

make_archive valid-v2 valid
IMPORT_HOME="$TMP/home"
result="$(/usr/bin/env HOME="$IMPORT_HOME" NODE="$NODE_BIN" \
  "$ROOT/scripts/import-theme-zip-macos.sh" --file "$TMP/valid-v2.zip")"
imported_id="$("$NODE_BIN" -e '
  const value = JSON.parse(process.argv[1]);
  if (value.status !== "imported" || value.packageFormat !== "official") process.exit(2);
  process.stdout.write(value.id);
' "$result")"
saved="$IMPORT_HOME/Library/Application Support/CodexDreamSkinStudio/themes/$imported_id"
[ -f "$saved/media/loop.mp4" ]
[ -f "$saved/media/poster.webp" ]
[ -f "$saved/audio/ambient.m4a" ]
[ -f "$saved/audio/ui/complete.wav" ]
[ ! -e "$IMPORT_HOME/Library/Application Support/CodexDreamSkinStudio/theme" ]

make_archive long-id-v2 long-id
long_result="$(/usr/bin/env HOME="$IMPORT_HOME" NODE="$NODE_BIN" \
  "$ROOT/scripts/import-theme-zip-macos.sh" --file "$TMP/long-id-v2.zip")"
long_imported_id="$("$NODE_BIN" -e '
  const value = JSON.parse(process.argv[1]);
  if (value.status !== "imported" || value.packageFormat !== "official") process.exit(2);
  process.stdout.write(value.id);
' "$long_result")"
[ "$long_imported_id" = "test.$(/usr/bin/printf '%0100d' 0 | /usr/bin/tr '0' 'a')" ]
[ -f "$IMPORT_HOME/Library/Application Support/CodexDreamSkinStudio/themes/$long_imported_id/media/loop.mp4" ]

make_archive rejected-v2 undeclared
if /usr/bin/env HOME="$IMPORT_HOME" NODE="$NODE_BIN" \
  "$ROOT/scripts/import-theme-zip-macos.sh" --file "$TMP/rejected-v2.zip" \
  >"$TMP/rejected-output" 2>&1; then
  printf 'Importer unexpectedly accepted a v2 package with an undeclared file.\n' >&2
  exit 1
fi
state_root="$IMPORT_HOME/Library/Application Support/CodexDreamSkinStudio"
[ -z "$(/usr/bin/find "$state_root" -maxdepth 1 -name '.theme-import-work.*' -print -quit)" ]
[ "$(/usr/bin/find "$state_root/themes" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | /usr/bin/wc -l | /usr/bin/tr -d ' ')" = 2 ]
[ ! -e "$state_root/theme" ]

printf 'PASS: macOS imports nested v2 media atomically without changing the active theme.\n'
