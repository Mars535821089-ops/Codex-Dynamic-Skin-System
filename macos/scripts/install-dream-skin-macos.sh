#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

PORT=9341
CREATE_LAUNCHERS="false"
LAUNCH_AFTER_INSTALL="true"
IN_PLACE="false"
LAUNCHERS_ONLY="false"
ENGINE_ONLY="false"
ALLOW_AUTOMATIC_CODEX_RESTART="false"
PREVIOUS_AUTOSTART_WAS_DISABLED="false"
PREVIOUS_AUTOSTART_WAS_RUNNING="false"
AUTOSTART_DISABLED_MARKER="$STATE_ROOT/dream-skin-autostart.disabled"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --launchers) CREATE_LAUNCHERS="true"; shift ;;
    --no-launchers) CREATE_LAUNCHERS="false"; shift ;;
    --no-launch) LAUNCH_AFTER_INSTALL="false"; shift ;;
    --in-place) IN_PLACE="true"; shift ;;
    --launchers-only)
      LAUNCHERS_ONLY="true"
      CREATE_LAUNCHERS="true"
      LAUNCH_AFTER_INSTALL="false"
      shift
      ;;
    --engine-only)
      ENGINE_ONLY="true"
      CREATE_LAUNCHERS="false"
      LAUNCH_AFTER_INSTALL="false"
      shift
      ;;
    --allow-automatic-codex-restart)
      ALLOW_AUTOMATIC_CODEX_RESTART="true"
      shift
      ;;
    *) fail "Unknown installer argument: $1" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) fail "Invalid port: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "Port must be between 1024 and 65535."

deploy_project() {
  local temporary="$INSTALL_ROOT.installing.$$"
  local previous="$INSTALL_ROOT.previous.$$"
  /bin/rm -rf "$temporary"
  /bin/mkdir -p "$temporary"
  /usr/bin/rsync -a \
    --exclude '.git/' \
    --exclude '.DS_Store' \
    --exclude 'release/' \
    --exclude 'runtime/' \
    "$PROJECT_ROOT/" "$temporary/"
  /bin/chmod 700 "$temporary"/*.command "$temporary"/scripts/*.sh 2>/dev/null || true
  /bin/rm -rf "$previous"
  if [ -e "$INSTALL_ROOT" ]; then /bin/mv "$INSTALL_ROOT" "$previous"; fi
  if ! /bin/mv "$temporary" "$INSTALL_ROOT"; then
    [ -e "$previous" ] && /bin/mv "$previous" "$INSTALL_ROOT"
    fail "Could not install the project at $INSTALL_ROOT"
  fi
  DEPLOY_PREVIOUS="$previous"
}

commit_deployed_project() {
  [ -n "${DEPLOY_PREVIOUS:-}" ] || return 0
  /bin/rm -rf "$DEPLOY_PREVIOUS" || true
  DEPLOY_PREVIOUS=""
}

capture_previous_autostart_state() {
  local helper="$INSTALL_ROOT/scripts/install-dream-skin-autostart.sh"
  if [ -e "$AUTOSTART_DISABLED_MARKER" ]; then
    PREVIOUS_AUTOSTART_WAS_DISABLED="true"
    return 0
  fi
  if [ -x "$helper" ] && "$helper" status >/dev/null 2>&1; then
    PREVIOUS_AUTOSTART_WAS_RUNNING="true"
  fi
}

write_native_mode_marker() {
  local temporary="$AUTOSTART_DISABLED_MARKER.installing.$$"
  ensure_state_root
  if ! /usr/bin/printf 'native-mode\n' > "$temporary"; then
    return 1
  fi
  if ! /bin/chmod 600 "$temporary"; then
    /bin/rm -f "$temporary"
    return 1
  fi
  if ! /bin/mv -f "$temporary" "$AUTOSTART_DISABLED_MARKER"; then
    /bin/rm -f "$temporary"
    return 1
  fi
}

rollback_deployed_project() {
  local status="$1"
  local broken="$INSTALL_ROOT.broken.$$"
  local restore_previous_monitor="$PREVIOUS_AUTOSTART_WAS_RUNNING"
  # The LaunchAgent points through INSTALL_ROOT. Remove the new generation
  # before swapping directories so it cannot spin against a restored engine
  # that predates the monitor. A previous monitor is restored after the swap.
  if [ -x "$INSTALL_ROOT/scripts/install-dream-skin-autostart.sh" ]; then
    "$INSTALL_ROOT/scripts/install-dream-skin-autostart.sh" remove >/dev/null 2>&1 || true
  fi
  # Swap with renames only: `rm -rf` on the live root is not atomic, and an
  # interrupted deletion leaves a mixed-version engine behind.  Deleting the
  # detached broken tree afterwards is safe to interrupt.
  if [ -e "$INSTALL_ROOT" ]; then
    /bin/mv "$INSTALL_ROOT" "$broken" \
      || fail "Installation failed and the broken engine could not be moved aside."
  fi
  if [ -n "${DEPLOY_PREVIOUS:-}" ] && [ -e "$DEPLOY_PREVIOUS" ]; then
    /bin/mv "$DEPLOY_PREVIOUS" "$INSTALL_ROOT" \
      || fail "Installation failed and the previous engine could not be restored."
  fi
  /bin/rm -rf "$broken" 2>/dev/null || true
  if [ "$PREVIOUS_AUTOSTART_WAS_DISABLED" = "true" ]; then
    write_native_mode_marker \
      || printf 'Warning: persistent native mode could not be restored after the failed installation.\n' >&2
  elif [ "$restore_previous_monitor" = "true" ] \
    && [ "$PREVIOUS_AUTOSTART_WAS_RUNNING" = "true" ] \
    && [ -x "$INSTALL_ROOT/scripts/install-dream-skin-autostart.sh" ]; then
    "$INSTALL_ROOT/scripts/install-dream-skin-autostart.sh" install >/dev/null 2>&1 \
      || printf 'Warning: the previous automatic injection monitor could not be restored.\n' >&2
  fi
  DEPLOY_PREVIOUS=""
  return "$status"
}

DEPLOY_PREVIOUS=""

shell_quote() {
  printf '%q' "$1"
}

write_launcher() {
  local target="$1"
  local command="$2"
  if [ -e "$target" ] && ! /usr/bin/grep -q '^# CodexDreamSkinStudio launcher$' "$target" 2>/dev/null; then
    fail "Refusing to overwrite an unrelated Desktop file: $target"
  fi
  /usr/bin/printf '%s\n' \
    '#!/bin/bash' \
    '# CodexDreamSkinStudio launcher' \
    'set -e' \
    "$command" > "$target"
  /bin/chmod 700 "$target"
}

write_desktop_launchers() {
  /bin/mkdir -p "$HOME/Desktop"
  local start_script customize_script verify_script restore_script screenshot
  start_script="$(shell_quote "$SCRIPT_DIR/start-dream-skin-macos.sh")"
  customize_script="$(shell_quote "$SCRIPT_DIR/customize-theme-macos.sh")"
  verify_script="$(shell_quote "$SCRIPT_DIR/verify-dream-skin-macos.sh")"
  restore_script="$(shell_quote "$SCRIPT_DIR/restore-dream-skin-macos.sh")"
  screenshot="$(shell_quote "$HOME/Desktop/Codex Dream Skin Verification.png")"
  write_launcher "$HOME/Desktop/Codex Dream Skin.command" "exec $start_script --port $PORT --prompt-restart"
  write_launcher "$HOME/Desktop/Codex Dream Skin - Customize.command" "exec $customize_script"
  write_launcher "$HOME/Desktop/Codex Dream Skin - Verify.command" "$verify_script --screenshot $screenshot && /usr/bin/open $screenshot"
  write_launcher "$HOME/Desktop/Codex Dream Skin - Restore.command" "exec $restore_script --restore-base-theme --restart-codex"
}

discover_codex_app
if [ "$IN_PLACE" = "false" ] && [ "$PROJECT_ROOT" != "$INSTALL_ROOT" ]; then
  # Run the cheap precondition before any engine bytes move: aborting after
  # the copy forces a rollback of a perfectly good previous engine, and an
  # interrupted rollback is how a mixed-version tree ships.
  if [ "$LAUNCHERS_ONLY" != "true" ] && [ "$ENGINE_ONLY" != "true" ]; then
    codex_is_running && fail "Close Codex before installation so config.toml cannot be rewritten while the app is saving it."
  fi
  /bin/mkdir -p "$(dirname "$INSTALL_ROOT")"
  capture_previous_autostart_state
  deploy_project
  install_args=(--in-place --port "$PORT")
  [ "$LAUNCHERS_ONLY" != "true" ] || install_args+=(--launchers-only)
  [ "$ENGINE_ONLY" != "true" ] || install_args+=(--engine-only)
  if [ "$CREATE_LAUNCHERS" = "true" ]; then
    install_args+=(--launchers)
  else
    install_args+=(--no-launchers)
  fi
  [ "$LAUNCH_AFTER_INSTALL" = "true" ] || install_args+=(--no-launch)
  [ "$ALLOW_AUTOMATIC_CODEX_RESTART" != "true" ] \
    || install_args+=(--allow-automatic-codex-restart)
  if "$INSTALL_ROOT/scripts/install-dream-skin-macos.sh" "${install_args[@]}"; then
    commit_deployed_project
    exit 0
  else
    status=$?
    rollback_deployed_project "$status"
    exit "$status"
  fi
fi

if [ "$LAUNCHERS_ONLY" = "true" ]; then
  write_desktop_launchers
  printf 'Codex Dream Skin Studio launcher installed at %s without changing or starting Codex.\n' "$PROJECT_ROOT"
  exit 0
fi

if [ "$ENGINE_ONLY" = "true" ]; then
  printf 'Codex Dream Skin Studio engine staged at %s without changing or starting Codex.\n' "$PROJECT_ROOT"
  printf 'No Desktop files were created.\n'
  exit 0
fi

require_macos_runtime
ensure_state_root
codex_is_running && fail "Close Codex before installation so config.toml cannot be rewritten while the app is saving it."
seed_bundled_presets
if [ ! -f "$THEME_DIR/theme.json" ]; then
  "$SCRIPT_DIR/switch-theme-macos.sh" --id preset-gothic-void-crusade --no-apply >/dev/null
else
  # Re-stage official presets so metadata upgrades (e.g. the #183 appearance
  # pin) reach an active copy staged by an older engine.
  ACTIVE_THEME_ID="$("$NODE" -e '
const fs = require("node:fs");
let id = "";
try { id = String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).id ?? ""); } catch {}
process.stdout.write(/^preset-[A-Za-z0-9_-]{1,72}$/.test(id) ? id : "");
' "$THEME_DIR/theme.json")"
  if [ -n "$ACTIVE_THEME_ID" ] && [ -d "$STATE_ROOT/themes/$ACTIVE_THEME_ID" ]; then
    "$SCRIPT_DIR/switch-theme-macos.sh" --id "$ACTIVE_THEME_ID" --no-apply >/dev/null
  fi
fi
[ -f "$CONFIG_PATH" ] || fail "Codex config not found: $CONFIG_PATH. Launch Codex once, close it, and rerun the installer."
"$NODE" "$INJECTOR" --check-payload --theme-dir "$THEME_DIR" >/dev/null
sync_appearance_pin
# Keep the injector itself one-shot and supervise it from a small identity-
# checking process. If Codex already has the required CDP arguments and only
# the watcher died, the supervisor is restricted to watcher-only repair.
if [ "$ALLOW_AUTOMATIC_CODEX_RESTART" = "true" ]; then
  "$SCRIPT_DIR/install-dream-skin-autostart.sh" install --allow-codex-restart
else
  "$SCRIPT_DIR/install-dream-skin-autostart.sh" install
fi

if [ "$CREATE_LAUNCHERS" = "true" ]; then
  write_desktop_launchers
fi

printf 'Codex Dream Skin Studio %s installed at %s for Codex %s using its signed Node.js %s.\n' \
  "$SKIN_VERSION" "$PROJECT_ROOT" "$CODEX_VERSION" "$NODE_VERSION"
if [ "$CREATE_LAUNCHERS" = "true" ]; then
  printf 'Desktop launchers were created by explicit request.\n'
else
  printf 'No Desktop files were created. Use the installed menu bar app or scripts under %s/scripts.\n' "$PROJECT_ROOT"
fi
printf 'Bundled presets are ready in your theme library — pick one from the menu bar (已保存的主题) or switch-theme.\n'
if [ "$ALLOW_AUTOMATIC_CODEX_RESTART" = "true" ]; then
  printf 'Automatic Codex restart was explicitly enabled; the background monitor may quit and escalate to TERM/KILL an ordinary Codex process.\n' >&2
else
  printf 'The background monitor will not quit or restart an ordinary Codex process.\n'
fi

if [ "$LAUNCH_AFTER_INSTALL" = "true" ]; then
  "$SCRIPT_DIR/start-dream-skin-macos.sh" --port "$PORT" --prompt-restart
fi
