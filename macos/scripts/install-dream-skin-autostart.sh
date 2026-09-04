#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

LABEL="com.openai.codex-dream-skin-autostart"
AGENT_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
MONITOR="$SCRIPT_DIR/dream-skin-autostart.mjs"
AUTOSTART_STATE="$STATE_ROOT/dream-skin-autostart.json"
DISABLED_MARKER="$STATE_ROOT/dream-skin-autostart.disabled"
LOG_OUT="$STATE_ROOT/dream-skin-autostart.log"
LOG_ERR="$STATE_ROOT/dream-skin-autostart-error.log"
COMMAND="${1:-install}"
[ "$#" -eq 0 ] || shift
ALLOW_CODEX_RESTART="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-codex-restart) ALLOW_CODEX_RESTART="true"; shift ;;
    *) fail "Unknown autostart argument: $1" ;;
  esac
done

agent_is_loaded() {
  /bin/launchctl print "gui/$(/usr/bin/id -u)/$LABEL" >/dev/null 2>&1
}

unload_agent() {
  agent_is_loaded || return 0
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$LABEL" >/dev/null 2>&1 \
    || /bin/launchctl remove "$LABEL" >/dev/null 2>&1 \
    || fail "Could not unload the automatic injection monitor; no files were removed."
}

validate_agent_path() {
  [ -f "$AGENT_PATH" ] && [ ! -L "$AGENT_PATH" ] \
    || fail "Automatic injection monitor plist is missing or unsafe: $AGENT_PATH"
  existing_label="$(/usr/bin/plutil -extract Label raw -o - "$AGENT_PATH" 2>/dev/null || true)"
  [ "$existing_label" = "$LABEL" ] \
    || fail "Refusing to operate on an unrelated LaunchAgent plist: $AGENT_PATH"
}

write_disabled_marker() {
  ensure_state_root
  local temporary="$DISABLED_MARKER.$$.tmp"
  /bin/rm -f "$temporary"
  /usr/bin/printf '%s\n' 'native-mode' > "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$DISABLED_MARKER"
}

resume_agent() {
  validate_agent_path
  if ! agent_is_loaded; then
    /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$AGENT_PATH" \
      || fail "Could not resume the automatic injection monitor."
  fi
  # Clear native-mode intent only after the monitor is loaded successfully.
  /bin/rm -f "$DISABLED_MARKER"
}

case "$COMMAND" in
  status)
    exec /bin/launchctl print "gui/$(/usr/bin/id -u)/$LABEL"
    ;;
  suspend)
    unload_agent
    printf 'Dream Skin automatic injection monitor suspended.\n'
    exit 0
    ;;
  resume)
    resume_agent
    printf 'Dream Skin automatic injection monitor resumed.\n'
    exit 0
    ;;
  disable)
    # Persist native-mode intent before unloading. Even if unloading fails, a
    # still-running supervisor sees the marker before making another change.
    write_disabled_marker
    unload_agent
    /bin/rm -f "$AGENT_PATH" "$AUTOSTART_STATE" "$LOG_OUT" "$LOG_ERR"
    printf 'Dream Skin automatic injection monitor disabled; native mode is persistent.\n'
    exit 0
    ;;
  remove)
    unload_agent
    /bin/rm -f "$AGENT_PATH" "$AUTOSTART_STATE" "$DISABLED_MARKER" "$LOG_OUT" "$LOG_ERR"
    printf 'Dream Skin automatic injection monitor removed.\n'
    exit 0
    ;;
  install|enable) ;;
  *) fail "Unknown autostart command: $COMMAND" ;;
esac

discover_codex_app
require_macos_runtime quick
for required in \
  "$MONITOR" \
  "$SCRIPT_DIR/start-dream-skin-macos.sh" \
  "$SCRIPT_DIR/status-dream-skin-macos.sh"; do
  [ -f "$required" ] && [ ! -L "$required" ] \
    || fail "Automatic injection monitor dependency is missing or unsafe: $required"
done
ensure_state_root
/bin/mkdir -p "$HOME/Library/LaunchAgents"
[ ! -L "$HOME/Library/LaunchAgents" ] || fail "LaunchAgents directory must not be a symbolic link."

if [ -e "$AGENT_PATH" ]; then
  validate_agent_path
fi

unload_agent
TEMPORARY="$AGENT_PATH.$$.tmp"
monitor_arguments=(
  "$NODE" "$MONITOR" --watch
  --app-executable "$CODEX_EXE"
  --start-script "$SCRIPT_DIR/start-dream-skin-macos.sh"
  --status-script "$SCRIPT_DIR/status-dream-skin-macos.sh"
  --state "$AUTOSTART_STATE"
  --disabled-marker "$DISABLED_MARKER"
)
if [ "$ALLOW_CODEX_RESTART" = "true" ]; then
  monitor_arguments+=(--allow-codex-restart)
fi
ARGUMENTS="$($NODE -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
  "${monitor_arguments[@]}")"
/bin/rm -f "$TEMPORARY"
/usr/bin/plutil -create xml1 "$TEMPORARY"
/usr/bin/plutil -insert Label -string "$LABEL" "$TEMPORARY"
/usr/bin/plutil -insert ProgramArguments -json "$ARGUMENTS" "$TEMPORARY"
/usr/bin/plutil -insert RunAtLoad -bool true "$TEMPORARY"
/usr/bin/plutil -insert KeepAlive -bool true "$TEMPORARY"
/usr/bin/plutil -insert ThrottleInterval -integer 30 "$TEMPORARY"
/usr/bin/plutil -insert ProcessType -string Background "$TEMPORARY"
/usr/bin/plutil -insert StandardOutPath -string "$LOG_OUT" "$TEMPORARY"
/usr/bin/plutil -insert StandardErrorPath -string "$LOG_ERR" "$TEMPORARY"
/bin/chmod 600 "$TEMPORARY"
/bin/mv -f "$TEMPORARY" "$AGENT_PATH"
if ! /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$AGENT_PATH"; then
  /bin/rm -f "$AGENT_PATH"
  fail "Could not load the automatic injection monitor."
fi
# Successful install/enable is the explicit operation that leaves native mode.
/bin/rm -f "$DISABLED_MARKER"
printf 'Dream Skin automatic injection monitor installed.\n'
if [ "$ALLOW_CODEX_RESTART" = "true" ]; then
  printf 'Automatic Codex restart is enabled: the background monitor may quit and, if needed, TERM/KILL ordinary Codex processes.\n' >&2
else
  printf 'Automatic Codex restart is disabled; ordinary Codex processes are never quit by the background monitor.\n'
fi
