#!/bin/bash

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(/usr/bin/mktemp -d /tmp/dreamskin-restore-transaction.XXXXXX)"
cleanup() {
  /bin/chmod -R u+w "$TMP" 2>/dev/null || true
  /bin/rm -rf "$TMP"
}
trap cleanup EXIT

SANDBOX="$TMP/sandbox"
SCRIPTS="$SANDBOX/scripts"
TEST_ROOT="$TMP/state"
EVENT_LOG="$TMP/events.log"
/bin/mkdir -p "$SCRIPTS"
/bin/cp "$ROOT/scripts/restore-dream-skin-macos.sh" "$SCRIPTS/restore-dream-skin-macos.sh"

/usr/bin/printf '%s\n' \
  '#!/bin/bash' \
  'set -euo pipefail' \
  'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"' \
  'STATE_ROOT="$TEST_ROOT/runtime"' \
  'STATE_PATH="$STATE_ROOT/state.json"' \
  'OPERATION_STATE_PATH="$STATE_ROOT/operation-state.plist"' \
  'OPERATION_ACK_PATH="$STATE_ROOT/operation-control-ack.json"' \
  'THEME_BACKUP_PATH="$STATE_ROOT/theme-backup.json"' \
  'THEME_DIR="$STATE_ROOT/theme"' \
  'CONFIG_PATH="$TEST_ROOT/config.toml"' \
  'NODE=/usr/bin/true' \
  'INJECTOR="$TEST_ROOT/injector.mjs"' \
  'record() { /usr/bin/printf "%s\n" "$1" >> "$EVENT_LOG"; }' \
  'fail() { /usr/bin/printf "fixture: %s\n" "$*" >&2; exit 1; }' \
  'discover_codex_app() { record preflight:discover; [ "${SCENARIO:-}" != preflight-fail ] || fail "fixture preflight failed"; }' \
  'require_macos_runtime() { record preflight:runtime; }' \
  'ensure_state_root() { record mutation:ensure-state; /bin/mkdir -p "$STATE_ROOT"; }' \
  'state_field() { /usr/bin/printf "9341\n"; }' \
  'stop_recorded_injector() { record mutation:stop-injector; [ "${SCENARIO:-}" != post-suspend-fail ]; }' \
  'release_codex_launchd_job() { record mutation:release-codex-job; }' \
  'codex_is_running() { return 1; }' \
  'verified_cdp_endpoint() { return 1; }' \
  'stop_codex() { record mutation:stop-codex; }' \
  'launch_codex_normally() { record mutation:launch-codex; }' \
  'clear_operation_state() { record mutation:clear-operation; /bin/rm -f "$OPERATION_STATE_PATH"; }' \
  > "$SCRIPTS/common-macos.sh"

/usr/bin/printf '%s\n' \
  '#!/bin/bash' \
  'set -euo pipefail' \
  'command="${1:-install}"' \
  '/usr/bin/printf "monitor:%s\n" "$command" >> "$EVENT_LOG"' \
  'case "$command" in' \
  '  status) [ -f "$TEST_ROOT/monitor.running" ] ;;' \
  '  suspend) /bin/rm -f "$TEST_ROOT/monitor.running"; /usr/bin/touch "$TEST_ROOT/monitor.suspended" ;;' \
  '  resume) /usr/bin/touch "$TEST_ROOT/monitor.running"; /bin/rm -f "$TEST_ROOT/monitor.suspended" "$TEST_ROOT/native.disabled" ;;' \
  '  disable) /bin/rm -f "$TEST_ROOT/monitor.running" "$TEST_ROOT/monitor.suspended"; /usr/bin/touch "$TEST_ROOT/native.disabled" ;;' \
  '  remove) /bin/rm -f "$TEST_ROOT/monitor.running" "$TEST_ROOT/monitor.suspended" "$TEST_ROOT/native.disabled"; /usr/bin/touch "$TEST_ROOT/monitor.removed" ;;' \
  '  *) exit 64 ;;' \
  'esac' \
  > "$SCRIPTS/install-dream-skin-autostart.sh"
/bin/chmod 700 "$SCRIPTS"/*.sh

reset_case() {
  /bin/rm -rf "$TEST_ROOT"
  /bin/mkdir -p "$TEST_ROOT/runtime"
  /usr/bin/touch "$TEST_ROOT/monitor.running"
  : > "$EVENT_LOG"
}

assert_before() {
  local first="$1"
  local second="$2"
  local first_line second_line
  first_line="$(/usr/bin/grep -n -F -m 1 "$first" "$EVENT_LOG" | /usr/bin/cut -d: -f1)"
  second_line="$(/usr/bin/grep -n -F -m 1 "$second" "$EVENT_LOG" | /usr/bin/cut -d: -f1)"
  [ -n "$first_line" ] && [ -n "$second_line" ] && [ "$first_line" -lt "$second_line" ] || {
    /bin/cat "$EVENT_LOG" >&2
    /usr/bin/printf 'Expected %s before %s.\n' "$first" "$second" >&2
    exit 1
  }
}

# A failing read-only preflight cannot unload or delete the existing monitor.
reset_case
/usr/bin/touch "$TEST_ROOT/runtime/state.json"
if HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" EVENT_LOG="$EVENT_LOG" SCENARIO=preflight-fail \
  "$SCRIPTS/restore-dream-skin-macos.sh" --uninstall >/dev/null 2>&1; then
  /usr/bin/printf 'Preflight failure fixture unexpectedly succeeded.\n' >&2
  exit 1
fi
[ -f "$TEST_ROOT/monitor.running" ] || {
  /bin/cat "$EVENT_LOG" >&2
  /usr/bin/printf 'Uninstall mutated the monitor before preflight completed.\n' >&2
  exit 1
}
! /usr/bin/grep -E -q '^monitor:(suspend|disable|remove)$' "$EVENT_LOG"

# A later failure must roll a previously running monitor back to running.
reset_case
/usr/bin/touch "$TEST_ROOT/runtime/state.json"
if HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" EVENT_LOG="$EVENT_LOG" SCENARIO=post-suspend-fail \
  "$SCRIPTS/restore-dream-skin-macos.sh" --uninstall >/dev/null 2>&1; then
  /usr/bin/printf 'Post-suspend failure fixture unexpectedly succeeded.\n' >&2
  exit 1
fi
[ -f "$TEST_ROOT/monitor.running" ] || {
  /bin/cat "$EVENT_LOG" >&2
  /usr/bin/printf 'Failed uninstall did not resume the previous monitor.\n' >&2
  exit 1
}
assert_before preflight:runtime monitor:status
assert_before monitor:suspend mutation:stop-injector
assert_before mutation:stop-injector monitor:resume

# A failed attempt must not enable a monitor that was stopped beforehand.
reset_case
/bin/rm -f "$TEST_ROOT/monitor.running"
/usr/bin/touch "$TEST_ROOT/runtime/state.json"
if HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" EVENT_LOG="$EVENT_LOG" SCENARIO=post-suspend-fail \
  "$SCRIPTS/restore-dream-skin-macos.sh" --uninstall >/dev/null 2>&1; then
  /usr/bin/printf 'Stopped-monitor failure fixture unexpectedly succeeded.\n' >&2
  exit 1
fi
[ ! -f "$TEST_ROOT/monitor.running" ]
! /usr/bin/grep -F -q 'monitor:resume' "$EVENT_LOG"

# A successful Restore commits persistent native mode instead of re-enabling.
reset_case
HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" EVENT_LOG="$EVENT_LOG" SCENARIO=success \
  "$SCRIPTS/restore-dream-skin-macos.sh" >/dev/null
[ -f "$TEST_ROOT/native.disabled" ] || {
  /bin/cat "$EVENT_LOG" >&2
  /usr/bin/printf 'Restore did not persist the native/disabled intent.\n' >&2
  exit 1
}
assert_before preflight:runtime monitor:status
assert_before monitor:suspend mutation:release-codex-job
assert_before mutation:clear-operation monitor:disable

# A successful uninstall removes the suspended monitor only at commit.
reset_case
/usr/bin/touch "$TEST_ROOT/runtime/state.json"
HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" EVENT_LOG="$EVENT_LOG" SCENARIO=success \
  "$SCRIPTS/restore-dream-skin-macos.sh" --uninstall >/dev/null
[ -f "$TEST_ROOT/monitor.removed" ]
assert_before preflight:runtime monitor:status
assert_before monitor:suspend mutation:stop-injector
assert_before mutation:clear-operation monitor:remove

/usr/bin/printf 'PASS: macOS Restore/uninstall monitor lifecycle is preflighted and transactional.\n'
