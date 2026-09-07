#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
NODE="$(command -v node)"
cd "$ROOT"
run_node_group() {
  local label="$1"
  shift
  /usr/bin/printf 'RUN: %s\n' "$label"
  "$NODE" --test "$@"
}
run_node_group 'root tool tests' "$ROOT"/tools/*.test.mjs
run_node_group 'tool regression tests' "$ROOT"/tools/tests/*.test.mjs
run_node_group 'macOS native and portable tests' "$ROOT"/macos/tests/*.test.mjs
run_node_group 'Windows portable tests' "$ROOT"/windows/tests/*.test.mjs
NODE="$NODE" "$ROOT/macos/tests/theme-import-identity.test.sh"
/bin/bash "$ROOT/macos/tests/restore-lifecycle-transaction.test.sh"
while IFS= read -r script; do /bin/bash -n "$script"; done < <(
  /usr/bin/find "$ROOT/macos" -type f -name '*.sh' -print
)
/usr/bin/printf 'PASS: public macOS source and portable theme runtime\n'
