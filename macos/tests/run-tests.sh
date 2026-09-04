#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
NODE="$(command -v node)"
cd "$ROOT"
"$NODE" --test \
  "$ROOT"/tools/*.test.mjs \
  "$ROOT"/tools/tests/*.test.mjs \
  "$ROOT"/macos/tests/*.test.mjs \
  "$ROOT"/windows/tests/*.test.mjs
NODE="$NODE" "$ROOT/macos/tests/theme-import-identity.test.sh"
/bin/bash "$ROOT/macos/tests/restore-lifecycle-transaction.test.sh"
while IFS= read -r script; do /bin/bash -n "$script"; done < <(
  /usr/bin/find "$ROOT/macos" -type f -name '*.sh' -print
)
/usr/bin/printf 'PASS: public macOS source and portable theme runtime\n'
