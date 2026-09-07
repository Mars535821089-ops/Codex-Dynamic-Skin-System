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
run_shell_test() {
  local label="$1"
  local script="$2"
  /usr/bin/printf 'RUN: %s\n' "$label"
  local output
  local status=0
  output="$(/usr/bin/mktemp /tmp/dreamskin-shell-test.XXXXXX)"
  NODE="$NODE" /bin/bash "$script" >"$output" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    /bin/cat "$output"
    /bin/rm -f "$output"
    return 0
  fi
  /bin/cat "$output" >&2
  /bin/rm -f "$output"
  /usr/bin/printf 'FAIL: %s (exit %s)\n' "$label" "$status" >&2
  return "$status"
}
run_shell_test 'macOS community import identity' "$ROOT/macos/tests/theme-import-identity.test.sh"
run_shell_test 'macOS restore lifecycle transaction' "$ROOT/macos/tests/restore-lifecycle-transaction.test.sh"
while IFS= read -r script; do /bin/bash -n "$script"; done < <(
  /usr/bin/find "$ROOT/macos" -type f -name '*.sh' -print
)
/usr/bin/printf 'PASS: public macOS source and portable theme runtime\n'
