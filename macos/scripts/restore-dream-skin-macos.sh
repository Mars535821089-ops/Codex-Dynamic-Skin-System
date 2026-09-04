#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

PORT=9341
PORT_EXPLICIT="false"
RESTORE_BASE_THEME="false"
RESTART_CODEX="false"
UNINSTALL="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; PORT_EXPLICIT="true"; shift 2 ;;
    --restore-base-theme) RESTORE_BASE_THEME="true"; shift ;;
    --restart-codex) RESTART_CODEX="true"; shift ;;
    --uninstall) UNINSTALL="true"; shift ;;
    *) fail "Unknown restore argument: $1" ;;
  esac
done

AUTOSTART_HELPER="$SCRIPT_DIR/install-dream-skin-autostart.sh"
[ -f "$AUTOSTART_HELPER" ] && [ ! -L "$AUTOSTART_HELPER" ] && [ -x "$AUTOSTART_HELPER" ] \
  || fail "Automatic injection monitor helper is missing or unsafe: $AUTOSTART_HELPER"

# Classify the engine-only uninstall path without changing either the engine or
# the monitor. Any failure before begin_autostart_transaction is read-only.
ENGINE_ONLY_CLEANUP="false"
ENGINE_ONLY_REMOVE_BACKUP="false"
ENGINE_ONLY_MESSAGE=""
if [ "$UNINSTALL" = "true" ] && [ ! -e "$STATE_PATH" ] &&
    [ ! -e "$OPERATION_STATE_PATH" ] && [ ! -e "$OPERATION_ACK_PATH" ]; then
  if [ ! -e "$THEME_BACKUP_PATH" ]; then
    ENGINE_ONLY_CLEANUP="true"
    ENGINE_ONLY_MESSAGE="No active Dream Skin session or config backup was found; safe engine-only cleanup."
  else
    backup_appearance="$(/usr/bin/plutil -extract values.appearanceTheme raw -o - "$THEME_BACKUP_PATH" 2>/dev/null || true)"
    backup_dark_code="$(/usr/bin/plutil -extract values.appearanceDarkCodeThemeId raw -o - "$THEME_BACKUP_PATH" 2>/dev/null || true)"
    # Install may have pinned appearanceTheme even when the backup recorded no
    # original line; a pinned config still needs the full restore below.
    if [ "$backup_appearance" = "null" ] && [ "$backup_dark_code" = "null" ] &&
        ! /usr/bin/grep -E -q '^[[:space:]]*appearanceTheme[[:space:]]*=' "$CONFIG_PATH" 2>/dev/null; then
      ENGINE_ONLY_CLEANUP="true"
      ENGINE_ONLY_REMOVE_BACKUP="true"
      ENGINE_ONLY_MESSAGE="The install created no config overrides; safe engine-only cleanup."
    fi
  fi
fi

if [ "$ENGINE_ONLY_CLEANUP" != "true" ]; then
  discover_codex_app
  require_macos_runtime
  if [ "$PORT_EXPLICIT" = "false" ] && [ -f "$STATE_PATH" ]; then
    PORT="$(state_field port)" || fail "Could not read the saved CDP port; state was preserved."
  fi
fi

AUTOSTART_TRANSACTION_ACTIVE="false"
AUTOSTART_WAS_RUNNING="false"

rollback_autostart_transaction() {
  local status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$AUTOSTART_TRANSACTION_ACTIVE" = "true" ] &&
      [ "$AUTOSTART_WAS_RUNNING" = "true" ]; then
    "$AUTOSTART_HELPER" resume >/dev/null 2>&1 \
      || printf 'Warning: restore failed and the previous automatic injection monitor could not be resumed.\n' >&2
  fi
  exit "$status"
}

begin_autostart_transaction() {
  if "$AUTOSTART_HELPER" status >/dev/null 2>&1; then
    AUTOSTART_WAS_RUNNING="true"
  fi
  AUTOSTART_TRANSACTION_ACTIVE="true"
  "$AUTOSTART_HELPER" suspend >/dev/null
}

commit_autostart_transaction() {
  if [ "$UNINSTALL" = "true" ]; then
    "$AUTOSTART_HELPER" remove >/dev/null
  else
    # Restore is durable native-mode intent. Reinstall or the helper's explicit
    # enable command is required before the supervisor can act again.
    "$AUTOSTART_HELPER" disable >/dev/null
  fi
  AUTOSTART_TRANSACTION_ACTIVE="false"
  trap - EXIT
}

trap rollback_autostart_transaction EXIT
begin_autostart_transaction

if [ "$ENGINE_ONLY_CLEANUP" = "true" ]; then
  if [ "$ENGINE_ONLY_REMOVE_BACKUP" = "true" ]; then
    /bin/rm -f "$THEME_BACKUP_PATH"
  fi
  commit_autostart_transaction
  printf '%s\n' "$ENGINE_ONLY_MESSAGE"
  exit 0
fi

ensure_state_root
if [ -f "$STATE_PATH" ]; then
  stop_recorded_injector \
    || fail "Could not stop the recorded injector; restore state was preserved."
fi
# Always remove the themed ChatGPT launchd job so quitting ChatGPT stays quit.
release_codex_launchd_job || true
CODEX_RUNNING="false"
codex_is_running && CODEX_RUNNING="true"
DEBUG_READY="false"
verified_cdp_endpoint "$PORT" && DEBUG_READY="true"

if [ "$DEBUG_READY" = "true" ]; then
  "$NODE" "$INJECTOR" --remove --port "$PORT" --theme-dir "$THEME_DIR" --timeout-ms 8000 >/dev/null \
    || fail "The live skin could not be removed and verified; restore stopped safely."
elif [ "$CODEX_RUNNING" = "true" ] && [ "$RESTART_CODEX" = "false" ]; then
  fail "ChatGPT is still running but its saved CDP endpoint cannot be verified. Pass --restart-codex for a full restore."
fi

if [ "$RESTORE_BASE_THEME" = "true" ]; then
  if [ "$CODEX_RUNNING" = "true" ]; then
    [ "$RESTART_CODEX" = "true" ] \
      || fail "Close ChatGPT or pass --restart-codex before restoring config.toml."
    stop_codex true
    CODEX_RUNNING="false"
  fi
  "$NODE" "$SCRIPT_DIR/theme-config.mjs" restore "$CONFIG_PATH" "$THEME_BACKUP_PATH"
fi

if [ "$RESTART_CODEX" = "true" ]; then
  [ "$CODEX_RUNNING" = "true" ] && stop_codex true
  launch_codex_normally
fi

/bin/rm -f "$STATE_PATH"
clear_operation_state
/bin/rm -f "$OPERATION_ACK_PATH"
if [ "$UNINSTALL" = "true" ]; then
  for launcher in \
    "$HOME/Desktop/Codex Dream Skin.command" \
    "$HOME/Desktop/Codex Dream Skin - Customize.command" \
    "$HOME/Desktop/Codex Dream Skin - Verify.command" \
    "$HOME/Desktop/Codex Dream Skin - Restore.command"; do
    if [ -f "$launcher" ] && [ ! -L "$launcher" ] &&
       /usr/bin/grep -F -q '# CodexDreamSkinStudio launcher' "$launcher"; then
      /bin/rm -f "$launcher"
    fi
  done
fi

commit_autostart_transaction
printf 'ChatGPT Dream Skin was removed and the requested macOS restore actions completed successfully.\n'
