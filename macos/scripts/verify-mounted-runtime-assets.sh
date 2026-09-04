#!/bin/bash

set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s <source-assets> <mounted-assets>\n' "$0" >&2
  exit 2
fi

SOURCE_ASSETS="$1"
MOUNTED_ASSETS="$2"

[ -d "$SOURCE_ASSETS" ] \
  || { printf 'Source runtime assets directory is missing: %s\n' "$SOURCE_ASSETS" >&2; exit 2; }
[ -d "$MOUNTED_ASSETS" ] \
  || { printf 'Mounted runtime assets directory is missing: %s\n' "$MOUNTED_ASSETS" >&2; exit 2; }

if DIFF_OUTPUT="$(/usr/bin/diff -qr "$SOURCE_ASSETS" "$MOUNTED_ASSETS" 2>&1)"; then
  printf 'Mounted runtime assets match source byte-for-byte.\n'
  exit 0
fi

printf 'Mounted runtime asset mismatch; refusing stale or incomplete release.\n' >&2
printf '%s\n' "$DIFF_OUTPUT" >&2
exit 1
