#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
EXTRACTOR="$ROOT/scripts/extract-theme-zip-macos.sh"
FIXTURE_BUILDER="$ROOT/tests/helpers/make-zip-fixture.mjs"
NODE_BIN="${NODE:-$(command -v node 2>/dev/null || true)}"
[ -x "$NODE_BIN" ] || NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
[ -x "$NODE_BIN" ] || { printf 'Node.js runtime was not found.\n' >&2; exit 1; }

TMP="$(/usr/bin/mktemp -d /tmp/codex-dynamic-skin-zip-structure.XXXXXX)"
trap '/bin/rm -rf "$TMP"' EXIT

make_fixture() {
  "$NODE_BIN" "$FIXTURE_BUILDER" "$TMP/$1.zip" "$1"
}

expect_accepted() {
  local scenario="$1"
  local destination="$TMP/accepted-$scenario"
  make_fixture "$scenario"
  /bin/mkdir -p "$destination"
  DREAMSKIN_NODE="$NODE_BIN" "$EXTRACTOR" "$TMP/$scenario.zip" "$destination"
  [ -f "$destination/theme.json" ] || { printf '%s did not extract theme.json.\n' "$scenario" >&2; exit 1; }
  [ -f "$destination/media/loop.mp4" ] || { printf '%s did not preserve nested media.\n' "$scenario" >&2; exit 1; }
}

expect_rejected() {
  local scenario="$1"
  local destination="$TMP/rejected-$scenario"
  make_fixture "$scenario"
  /bin/mkdir -p "$destination"
  if DREAMSKIN_NODE="$NODE_BIN" "$EXTRACTOR" "$TMP/$scenario.zip" "$destination" >/dev/null 2>&1; then
    printf 'ZIP extractor unexpectedly accepted %s.\n' "$scenario" >&2
    exit 1
  fi
  if [ -n "$(/usr/bin/find "$destination" -mindepth 1 -print -quit)" ]; then
    printf 'Rejected ZIP left staged output for %s.\n' "$scenario" >&2
    exit 1
  fi
}

expect_accepted valid-nested
expect_accepted valid-deflate

for scenario in duplicate case-collision unicode-collision traversal absolute \
  windows-device control symlink fifo unsupported encrypted oversized-entry \
  oversized-total nested-archive too-many; do
  expect_rejected "$scenario"
done

printf 'PASS: macOS ZIP structure preflight accepts nested media and rejects hostile archives.\n'
