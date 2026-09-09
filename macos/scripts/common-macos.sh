#!/bin/bash

set -euo pipefail

if [ -z "${HOME:-}" ]; then
  CURRENT_USER="$(/usr/bin/id -un)"
  HOME="$(/usr/bin/dscl . -read "/Users/$CURRENT_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')"
  [ -n "$HOME" ] || { printf 'ChatGPT Dream Skin: could not resolve the current macOS home directory.\n' >&2; exit 1; }
  export HOME
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/localization-macos.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INJECTOR="$SCRIPT_DIR/injector.mjs"
SELECTED_THEME_RESOLVER="$SCRIPT_DIR/resolve-selected-theme-directory.mjs"
INSTALL_ROOT="$HOME/.codex/codex-dream-skin-studio"
STATE_ROOT="$HOME/Library/Application Support/CodexDreamSkinStudio"
STATE_PATH="$STATE_ROOT/state.json"
OPERATION_STATE_PATH="$STATE_ROOT/operation-state.plist"
OPERATION_ACK_PATH="$STATE_ROOT/operation-control-ack.json"
THEME_BACKUP_PATH="$STATE_ROOT/theme-backup.json"
THEME_DIR="$STATE_ROOT/theme"
CONFIG_PATH="$HOME/.codex/config.toml"
INJECTOR_LOG="$STATE_ROOT/injector.log"
INJECTOR_ERROR_LOG="$STATE_ROOT/injector-error.log"
APP_LOG="$STATE_ROOT/codex-launch.log"
APP_ERROR_LOG="$STATE_ROOT/codex-launch-error.log"
START_ERROR_LOG="$STATE_ROOT/start-error.log"
CODEX_APP_JOB_LABEL="com.openai.codex-dream-skin-studio.app"
INJECTOR_JOB_LABEL="com.openai.codex-dream-skin-studio.injector"
EXPECTED_CODEX_TEAM_ID="2DC432GLL2"
EXPECTED_CODEX_REQUIREMENT="anchor apple generic and certificate leaf[subject.OU] = \"$EXPECTED_CODEX_TEAM_ID\""
SKIN_VERSION="1.5.17"
DREAM_SKIN_VALIDATED_RUNTIME_PID=""
DREAM_SKIN_VALIDATED_RUNTIME_BUNDLE=""
DREAM_SKIN_VALIDATED_RUNTIME_EXE=""
DREAM_SKIN_VALIDATED_RUNTIME_NODE=""

fail() {
  local message="$*"
  if [ -n "${START_ERROR_LOG:-}" ] && [ -n "${STATE_ROOT:-}" ]; then
    /bin/mkdir -p "$STATE_ROOT" 2>/dev/null || true
    printf '%s %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >> "$START_ERROR_LOG" 2>/dev/null || true
  fi
  printf 'ChatGPT Dream Skin: %s\n' "$message" >&2
  exit 1
}

resolve_current_theme_dir() {
  "$NODE" "$SELECTED_THEME_RESOLVER" \
    --fallback-theme-dir "$THEME_DIR" \
    --default-theme-library "$STATE_ROOT/themes" \
    --settings "$STATE_ROOT/dynamic-settings.json"
}

notify_user() {
  local message="$*"
  /usr/bin/osascript - "$message" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display notification (item 1 of argv) with title "ChatGPT Dream Skin"
end run
APPLESCRIPT
}

alert_user() {
  local message="$*"
  /usr/bin/osascript - "$message" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display alert "ChatGPT Dream Skin" message (item 1 of argv)
end run
APPLESCRIPT
}

ensure_state_root() {
  /bin/mkdir -p "$STATE_ROOT"
  /bin/chmod 700 "$STATE_ROOT"
}

submitted_start_job_matches() {
  local description="$1"
  local expected_program="$2"
  local line=""
  local program=""
  local arguments=""
  local candidate=""
  local home_program=""
  local braced_home_program=""
  local submitted="false"
  local keepalive="false"
  local in_arguments="false"
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      'path = (submitted by launchctl'*) submitted="true" ;;
      'program = '*) program="${line#program = }" ;;
      'arguments = {') in_arguments="true" ;;
      'properties = '*keepalive*) keepalive="true" ;;
      '}') [ "$in_arguments" != "true" ] || in_arguments="false" ;;
      *)
        if [ "$in_arguments" = "true" ]; then
          arguments="${arguments}${arguments:+$'\n'}${line}"
        fi
        ;;
    esac
  done <<< "$description"
  [ "$submitted" = "true" ] && [ "$keepalive" = "true" ] || return 1
  [ "$program" != "$expected_program" ] || return 0
  case "$program" in
    /bin/bash|/bin/zsh|/bin/sh) ;;
    *) return 1 ;;
  esac
  if [ -n "${HOME:-}" ]; then
    case "$expected_program" in
      "$HOME"/*)
        home_program="\$HOME${expected_program#"$HOME"}"
        braced_home_program="\${HOME}${expected_program#"$HOME"}"
        ;;
    esac
  fi
  while IFS= read -r line; do
    for candidate in "$expected_program" "$home_program" "$braced_home_program"; do
      [ -n "$candidate" ] || continue
      [ "$line" != "$candidate" ] || return 0
      case "$line" in
        *\""$candidate"\"*|*\'"$candidate"\'*) return 0 ;;
      esac
      case "$candidate" in
        *[[:space:]]*) ;;
        *) case " $line " in *" $candidate "*) return 0 ;; esac ;;
      esac
    done
  done <<< "$arguments"
  return 1
}

guard_against_submitted_keepalive_start() {
  local service="${XPC_SERVICE_NAME:-}"
  local description=""
  local expected_program="$SCRIPT_DIR/start-dream-skin-macos.sh"
  case "$service" in
    ''|*[!A-Za-z0-9._-]*) return 0 ;;
  esac
  description="$(/bin/launchctl print "gui/$(/usr/bin/id -u)/$service" 2>/dev/null)" || return 0
  submitted_start_job_matches "$description" "$expected_program" || return 0
  printf 'ChatGPT Dream Skin: refusing a launchctl-submitted KeepAlive start job (%s).\n' "$service" >&2
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$service" >/dev/null 2>&1 \
    || /bin/launchctl remove "$service" >/dev/null 2>&1 \
    || true
  return 75
}

new_operation_token() {
  local timestamp_ms=""
  if [ -x /usr/bin/perl ]; then
    timestamp_ms="$(LC_ALL=C /usr/bin/perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000')"
  else
    timestamp_ms="$(/bin/date +%s)000"
  fi
  /usr/bin/printf '%s:%s:%s\n' "$$" "$timestamp_ms" "${RANDOM:-0}"
}

operation_token_is_valid() {
  LC_ALL=C /usr/bin/printf '%s' "$1" \
    | LC_ALL=C /usr/bin/grep -Eq '^[0-9]{1,12}:[0-9]{13}:[0-9]{1,8}$'
}

write_operation_state() {
  local status="$1"
  local message="${2:-}"
  local operation_token="${3:-}"
  local terminal_policy="${4:-match}"
  local token_guarded="false"
  local current_token=""
  local current_status=""
  local current_updated_at=""
  local current_age=0
  local current_ttl=0
  local temporary=""
  local updated_at=""
  local lock_path=""
  local lock_mtime=""
  local now=""
  local attempts=0
  local result=0
  case "$status" in
    applying|pausing|success|paused|cancelled|failed) ;;
    *) return 1 ;;
  esac
  case "$terminal_policy" in match|idle) ;; *) return 1 ;; esac
  case "$message" in *$'\n'*|*$'\r'*) return 1 ;; esac
  [ "${#message}" -le 240 ] || return 1
  if [ -n "$operation_token" ]; then
    token_guarded="true"
  else
    operation_token="$(new_operation_token)"
  fi
  operation_token_is_valid "$operation_token" || return 1
  ensure_state_root
  lock_path="$STATE_ROOT/.operation-state.lock"
  while ! /bin/mkdir "$lock_path" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then return 1; fi
    lock_mtime="$(/usr/bin/stat -f '%m' "$lock_path" 2>/dev/null || true)"
    now="$(/bin/date +%s)"
    case "$lock_mtime" in
      ''|*[!0-9]*) ;;
      *) [ $((now - lock_mtime)) -le 5 ] || /bin/rm -rf "$lock_path" ;;
    esac
    /bin/sleep 0.02
  done
  case "$status" in
    success|paused|cancelled|failed)
      if [ "$token_guarded" = "true" ] && [ -f "$OPERATION_STATE_PATH" ]; then
        current_token="$(/usr/bin/plutil -extract operationToken raw -o - "$OPERATION_STATE_PATH" 2>/dev/null || true)"
        if [ "$current_token" != "$operation_token" ]; then
          if [ "$terminal_policy" = "idle" ]; then
            current_status="$(/usr/bin/plutil -extract status raw -o - "$OPERATION_STATE_PATH" 2>/dev/null || true)"
            current_updated_at="$(/usr/bin/plutil -extract updatedAt raw -o - "$OPERATION_STATE_PATH" 2>/dev/null || true)"
            case "$current_updated_at" in ''|*[!0-9]*) current_updated_at=0 ;; esac
            now="$(/bin/date +%s)"
            current_age=$((now - current_updated_at))
            case "$current_status" in applying) current_ttl=180 ;; pausing) current_ttl=90 ;; *) current_ttl=0 ;; esac
            if [ "$current_ttl" -gt 0 ] && [ "$current_age" -ge -5 ] \
              && [ "$current_age" -le "$current_ttl" ]; then
              result=2
            fi
          elif operation_token_is_valid "$current_token"; then
            result=2
          fi
        fi
      fi
      ;;
  esac
  if [ "$result" -eq 0 ]; then
    temporary="$OPERATION_STATE_PATH.$$.tmp"
    updated_at="$(/bin/date +%s)"
    /bin/rm -f "$temporary"
    if ! /usr/bin/plutil -create xml1 "$temporary" >/dev/null 2>&1 \
      || ! /usr/bin/plutil -insert status -string "$status" "$temporary" >/dev/null 2>&1 \
      || ! /usr/bin/plutil -insert message -string "$message" "$temporary" >/dev/null 2>&1 \
      || ! /usr/bin/plutil -insert operationToken -string "$operation_token" "$temporary" >/dev/null 2>&1 \
      || ! /usr/bin/plutil -insert updatedAt -integer "$updated_at" "$temporary" >/dev/null 2>&1; then
      /bin/rm -f "$temporary"
      result=1
    else
      /bin/chmod 600 "$temporary"
      /bin/mv -f "$temporary" "$OPERATION_STATE_PATH" || result=1
    fi
  fi
  /bin/rm -rf "$lock_path"
  return "$result"
}

clear_operation_state() {
  /bin/rm -f "$OPERATION_STATE_PATH"
}

begin_client_operation() {
  local port="$1"
  local kind="$2"
  local timeout_ms="${3:-3000}"
  local token="${4:-}"
  case "$kind" in apply|pause|switch) ;; *) return 1 ;; esac
  [ -n "$token" ] || token="$(new_operation_token)"
  operation_token_is_valid "$token" || return 1
  token="$("$NODE" "$INJECTOR" --begin-operation --operation-kind "$kind" \
    --operation-token "$token" --port "$port" --timeout-ms "$timeout_ms" \
    2>>"$INJECTOR_ERROR_LOG")" || return 1
  operation_token_is_valid "$token" || return 1
  /usr/bin/printf '%s\n' "$token"
}

finish_client_operation() {
  local port="$1"
  local state="$2"
  local message="$3"
  local token="$4"
  local timeout_ms="${5:-1500}"
  case "$state" in success|error|cancelled) ;; *) return 1 ;; esac
  operation_token_is_valid "$token" || return 1
  [ -n "${NODE:-}" ] && [ -x "$NODE" ] || return 1
  "$NODE" "$INJECTOR" --finish-operation --operation-ui-state "$state" \
    --operation-message "$message" --operation-token "$token" \
    --port "$port" --timeout-ms "$timeout_ms" 2>>"$INJECTOR_ERROR_LOG"
}

# Seed bundled preset packs into the user's themes/ library so a fresh install
# ships with ready-to-use skins. Idempotent (each preset is refreshed in place)
# and scoped to preset-* ids, so user-made custom-* packs are never touched.
seed_bundled_presets() {
  local presets_root="$PROJECT_ROOT/presets"
  [ -d "$presets_root" ] || return 0
  local themes_root="$STATE_ROOT/themes"
  /bin/mkdir -p "$themes_root"
  local retired
  for retired in \
    preset-midnight-aurora preset-sakura-dawn preset-amber-dusk \
    preset-forest-mist preset-cyber-neon preset-romantic-rose; do
    /bin/rm -rf "$themes_root/$retired"
  done
  local src id dest entry
  for src in "$presets_root"/preset-*/; do
    [ -d "$src" ] || continue
    [ -f "${src}theme.json" ] || continue
    id="$(/usr/bin/basename "$src")"
    dest="$themes_root/$id"
    /bin/rm -rf "$dest"
    /bin/mkdir -p "$dest"
    /bin/chmod 700 "$dest"
    for entry in "$src"*; do
      [ -f "$entry" ] || continue
      /bin/cp "$entry" "$dest/"
    done
    /bin/chmod 600 "$dest"/* 2>/dev/null || true
  done
}

discover_codex_app() {
  local candidate=""
  local identifier=""
  local executable_name=""
  local configured="${CODEX_APP_BUNDLE:-}"

  CODEX_BUNDLE=""
  for candidate in "$configured" \
    "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app" \
    "/Applications/Codex.app" "$HOME/Applications/Codex.app"; do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/Contents/Info.plist" ] || continue
    identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist" 2>/dev/null || true)"
    if [ "$identifier" = "com.openai.codex" ]; then
      CODEX_BUNDLE="$candidate"
      break
    fi
  done

  if [ -z "${CODEX_BUNDLE:-}" ]; then
    candidate="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' | /usr/bin/head -n 1)"
    if [ -n "$candidate" ] && [ -f "$candidate/Contents/Info.plist" ]; then
      identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist" 2>/dev/null || true)"
      [ "$identifier" = "com.openai.codex" ] && CODEX_BUNDLE="$candidate"
    fi
  fi

  [ -n "${CODEX_BUNDLE:-}" ] || fail "Could not find the official ChatGPT app bundle (com.openai.codex)."
  executable_name="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CODEX_BUNDLE/Contents/Info.plist")"
  CODEX_EXE="$CODEX_BUNDLE/Contents/MacOS/$executable_name"
  CODEX_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$CODEX_BUNDLE/Contents/Info.plist")"
  [ -x "$CODEX_EXE" ] || fail "ChatGPT executable is missing: $CODEX_EXE"
  export CODEX_BUNDLE CODEX_EXE CODEX_VERSION
}

codesign_team_id() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 \
    | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}'
}

remember_validated_runtime_identity() {
  DREAM_SKIN_VALIDATED_RUNTIME_PID="$$"
  DREAM_SKIN_VALIDATED_RUNTIME_BUNDLE="$CODEX_BUNDLE"
  DREAM_SKIN_VALIDATED_RUNTIME_EXE="$CODEX_EXE"
  DREAM_SKIN_VALIDATED_RUNTIME_NODE="$NODE"
}

require_signed_node_runtime() {
  [ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "This launcher requires macOS."
  [ -n "${CODEX_BUNDLE:-}" ] && [ -n "${CODEX_EXE:-}" ] \
    || fail "Discover the ChatGPT app before validating its runtime."

  RUNTIME_NODE="$CODEX_BUNDLE/Contents/Resources/cua_node/bin/node"
  [ -x "$RUNTIME_NODE" ] || fail "The signed Node.js runtime bundled with ChatGPT was not found: $RUNTIME_NODE"
  /usr/bin/codesign --verify --strict \
    --test-requirement "=$EXPECTED_CODEX_REQUIREMENT" "$RUNTIME_NODE" >/dev/null 2>&1 \
    || fail "The Node.js runtime bundled with ChatGPT failed code-signature validation."

  CODEX_TEAM_ID="$(codesign_team_id "$CODEX_BUNDLE")"
  NODE_TEAM_ID="$(codesign_team_id "$RUNTIME_NODE")"
  [ "$CODEX_TEAM_ID" = "$EXPECTED_CODEX_TEAM_ID" ] \
    || fail "Unexpected ChatGPT signing team: ${CODEX_TEAM_ID:-missing}."
  [ "$NODE_TEAM_ID" = "$EXPECTED_CODEX_TEAM_ID" ] \
    || fail "Unexpected bundled Node.js signing team: ${NODE_TEAM_ID:-missing}."

  local machine_arch
  local node_major
  machine_arch="$(/usr/bin/uname -m)"
  /usr/bin/file "$RUNTIME_NODE" | /usr/bin/grep -q "$machine_arch" \
    || fail "The ChatGPT Node.js runtime does not match this Mac architecture ($machine_arch)."
  NODE_VERSION="$($RUNTIME_NODE --version)"
  node_major="${NODE_VERSION#v}"
  node_major="${node_major%%.*}"
  case "$node_major" in ''|*[!0-9]*) fail "Could not parse bundled Node.js version: $NODE_VERSION" ;; esac
  [ "$node_major" -ge 20 ] || fail "ChatGPT bundled Node.js $NODE_VERSION is too old; version 20 or newer is required."

  NODE="$RUNTIME_NODE"
  export NODE RUNTIME_NODE NODE_VERSION CODEX_TEAM_ID NODE_TEAM_ID
  remember_validated_runtime_identity
}

verify_macos_app_signature() {
  local verification_mode="${1:-deep}"
  case "$verification_mode" in deep|quick) ;; *) fail "Unknown runtime verification mode: $verification_mode" ;; esac
  if [ "$verification_mode" = "deep" ]; then
    /usr/bin/codesign --verify --deep --strict \
      --test-requirement "=$EXPECTED_CODEX_REQUIREMENT" "$CODEX_BUNDLE" >/dev/null 2>&1 \
      || fail "The ChatGPT app signature is not valid. Restore or reinstall the official app before continuing."
  else
    /usr/bin/codesign --verify --strict \
      --test-requirement "=$EXPECTED_CODEX_REQUIREMENT" "$CODEX_BUNDLE" >/dev/null 2>&1 \
      || fail "The ChatGPT app signature is not valid. Restore or reinstall the official app before continuing."
  fi
}

require_macos_runtime() {
  local verification_mode="${1:-deep}"
  require_signed_node_runtime
  verify_macos_app_signature "$verification_mode"
}

codex_profile_pids_from_listing() {
  local profile="${1:-default}"
  local pid
  local command_line
  local isolated
  case "$profile" in default|isolated) ;; *) return 2 ;; esac
  while read -r pid command_line; do
    [ -n "$pid" ] || continue
    case "$command_line" in
      "$CODEX_EXE"*) ;;
      *) continue ;;
    esac
    isolated="false"
    case " $command_line " in
      *" --user-data-dir="*|*" --user-data-dir "*) isolated="true" ;;
    esac
    if { [ "$profile" = "default" ] && [ "$isolated" = "true" ]; } \
      || { [ "$profile" = "isolated" ] && [ "$isolated" != "true" ]; }; then
      continue
    fi
    pid_is_codex_executable "$pid" && printf '%s\n' "$pid"
  done
}

codex_main_pids() {
  /bin/ps -axo pid=,command= | codex_profile_pids_from_listing default
}

codex_isolated_main_pids() {
  /bin/ps -axo pid=,command= | codex_profile_pids_from_listing isolated
}

codex_is_running() {
  [ -n "$(codex_main_pids)" ]
}

codex_process_has_background_playback_flags() {
  local pid="$1"
  local command_line=""
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  command_line="$(/bin/ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
  [ -n "$command_line" ] || return 1
  case " $command_line " in *" --disable-background-media-suspend "*) ;; *) return 1 ;; esac
  case " $command_line " in *" --disable-backgrounding-occluded-windows "*) ;; *) return 1 ;; esac
  case " $command_line " in *" --disable-background-timer-throttling "*) ;; *) return 1 ;; esac
  case " $command_line " in *" --disable-renderer-backgrounding "*) ;; *) return 1 ;; esac
}

codex_background_playback_capable() {
  local pid=""
  [ -n "${CODEX_EXE:-}" ] || return 1
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    codex_process_has_background_playback_flags "$pid" && return 0
  done < <(codex_main_pids)
  return 1
}

dynamic_background_playback_enabled() {
  [ -n "${NODE:-}" ] && [ -x "$NODE" ] || return 1
  "$NODE" -e '
const fs = require("node:fs");
try {
  const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(settings?.backgroundPlayback === true ? 0 : 1);
} catch {
  process.exit(1);
}
' "$STATE_ROOT/dynamic-settings.json"
}

active_theme_appearance() {
  "$NODE" -e '
const fs = require("node:fs");
let appearance = "auto";
try { appearance = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).appearance; } catch {}
process.stdout.write(appearance === "light" || appearance === "dark" ? appearance : "auto");
' "$THEME_DIR/theme.json"
}

# Pin Codex appearanceTheme to the staged theme's declared appearance (or put
# the user's original line back for auto themes). Callers must only run this
# while Codex is closed; config writes race the app's own saves otherwise.
sync_appearance_pin() {
  "$NODE" "$SCRIPT_DIR/theme-config.mjs" install "$CONFIG_PATH" "$THEME_BACKUP_PATH" "$(active_theme_appearance)"
}

process_started_at() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

recorded_injector_process_matches() {
  local pid="$1"
  local expected_start="${2:-}"
  local expected_node="${3:-}"
  local expected_injector="${4:-}"
  local expected_port="${5:-}"
  local command_line=""
  local command_lower=""
  local node_lower=""
  local injector_lower=""
  local actual_start=""

  # A recorded PID is only safe to signal when the complete launch identity
  # was persisted.  Do not fall back to the current process paths: a stale or
  # hand-edited state file must fail closed instead of authorizing a reused PID.
  [ -n "$expected_start" ] && [ -n "$expected_node" ] && [ -n "$expected_injector" ] || return 1
  case "$expected_port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command_line" ] || return 1
  command_lower="$(printf '%s' "$command_line" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  injector_lower="$(printf '%s' "$expected_injector" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  node_lower="$(printf '%s' "$expected_node" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  case "$command_lower" in "$node_lower "*) ;; *) return 1 ;; esac
  # The watcher launch shape is deliberately matched as tokens.  In
  # particular, `--port 93410` must never satisfy a saved `9341` identity.
  case "$command_lower" in
    *"$injector_lower --watch --port $expected_port --theme-dir "*) ;;
    *) return 1 ;;
  esac
  actual_start="$(process_started_at "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ] || return 1
  return 0
}

signal_recorded_injector_process() {
  local signal="$1"
  local pid="$2"
  local expected_start="${3:-}"
  local expected_node="${4:-}"
  local expected_injector="${5:-}"
  local expected_port="${6:-}"
  case "$signal" in TERM|KILL) ;; *) return 2 ;; esac
  recorded_injector_process_matches "$pid" "$expected_start" "$expected_node" \
    "$expected_injector" "$expected_port" || return 0
  /bin/kill "-$signal" "$pid" 2>/dev/null || true
}

codex_process_identities() {
  local pid
  local started_at
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    started_at="$(process_started_at "$pid")"
    [ -n "$started_at" ] || continue
    pid_is_codex_executable "$pid" || continue
    /usr/bin/printf '%s\\t%s\\n' "$pid" "$started_at"
  done < <(codex_main_pids)
}

codex_process_identity_matches() {
  local pid="$1"
  local expected_start="$2"
  local actual_start=""
  [ -n "$expected_start" ] || return 1
  pid_is_codex_executable "$pid" || return 1
  actual_start="$(process_started_at "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ]
}

codex_identity_list_is_running() {
  local identities="$1"
  local pid
  local expected_start
  while IFS=$'\\t' read -r pid expected_start; do
    [ -n "$pid" ] || continue
    codex_process_identity_matches "$pid" "$expected_start" && return 0
  done <<< "$identities"
  return 1
}

signal_codex_identities() {
  local signal="$1"
  local identities="$2"
  local pid
  local expected_start
  case "$signal" in TERM|KILL) ;; *) return 2 ;; esac
  while IFS=$'\\t' read -r pid expected_start; do
    [ -n "$pid" ] || continue
    codex_process_identity_matches "$pid" "$expected_start" || continue
    /bin/kill "-$signal" "$pid" 2>/dev/null || true
  done <<< "$identities"
}

stop_codex() {
  local allow_force="${1:-false}"
  local deadline
  local target_identities

  release_codex_launchd_job
  target_identities="$(codex_process_identities)"
  [ -n "$target_identities" ] || return 0
  signal_codex_identities TERM "$target_identities"
  deadline=$((SECONDS + 15))
  while codex_identity_list_is_running "$target_identities" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.25
  done
  codex_identity_list_is_running "$target_identities" || return 0

  [ "$allow_force" = "true" ] || fail "ChatGPT did not close within 15 seconds; explicit restart authorization is required for a forced stop."
  signal_codex_identities TERM "$target_identities"
  deadline=$((SECONDS + 5))
  while codex_identity_list_is_running "$target_identities" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.25
  done
  if codex_identity_list_is_running "$target_identities"; then
    signal_codex_identities KILL "$target_identities"
  fi
  /bin/sleep 0.5
  codex_identity_list_is_running "$target_identities" && fail "ChatGPT could not be stopped safely."
  return 0
}

listener_pids() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u || true
}

port_is_available() {
  [ -z "$(listener_pids "$1")" ]
}

canonical_existing_path() {
  local input="$1"
  local directory
  local basename
  [ -e "$input" ] || return 1
  directory="$(cd "$(dirname "$input")" 2>/dev/null && pwd -P)" || return 1
  basename="$(basename "$input")"
  printf '%s/%s\n' "$directory" "$basename"
}

process_executable_path() {
  /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/{sub(/^n/, ""); print; exit}'
}

pid_is_codex_executable() {
  local actual
  local actual_canonical
  local expected_canonical
  actual="$(process_executable_path "$1")"
  actual_canonical="$(canonical_existing_path "$actual" 2>/dev/null || true)"
  expected_canonical="$(canonical_existing_path "$CODEX_EXE" 2>/dev/null || true)"
  [ -n "$actual_canonical" ] && [ "$actual_canonical" = "$expected_canonical" ]
}

pid_is_codex_descendant() {
  local current="$1"
  local command_line=""
  local parent=""
  local depth=0
  while [ "$current" -gt 1 ] 2>/dev/null && [ "$depth" -lt 32 ]; do
    command_line="$(/bin/ps -p "$current" -o command= 2>/dev/null || true)"
    case "$command_line" in
      "$CODEX_EXE"*) pid_is_codex_executable "$current" && return 0 ;;
    esac
    parent="$(/bin/ps -p "$current" -o ppid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')"
    case "$parent" in ''|*[!0-9]*) return 1 ;; esac
    [ "$parent" -ne "$current" ] || return 1
    current="$parent"
    depth=$((depth + 1))
  done
  return 1
}

port_belongs_to_codex() {
  local port="$1"
  local found="false"
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    found="true"
    pid_is_codex_descendant "$pid" || return 1
  done < <(listener_pids "$port")
  [ "$found" = "true" ]
}

# Cheap: can we talk to a loopback DevTools HTTP endpoint?
cdp_http_ready() {
  local port="$1"
  /usr/bin/curl --noproxy '*' --silent --fail --max-time 1 \
    "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1
}

verified_cdp_endpoint() {
  local port="$1"
  port_belongs_to_codex "$port" || return 1
  cdp_http_ready "$port"
}

select_available_port() {
  local preferred="$1"
  local candidate="$preferred"
  local last=$((preferred + 100))
  [ "$last" -le 65535 ] || last=65535
  while [ "$candidate" -le "$last" ]; do
    if port_is_available "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  fail "No free loopback port was found between $preferred and $last."
}

wait_for_cdp() {
  local port="$1"
  local deadline=$((SECONDS + 45))
  local last_note=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    verified_cdp_endpoint "$port" && return 0
    if [ $((SECONDS - last_note)) -ge 8 ]; then
      last_note=$SECONDS
      printf 'Waiting for ChatGPT debug port %s… (%ss)\n' "$port" "$SECONDS" >&2
    fi
    /bin/sleep 0.35
  done
  return 1
}

state_field() {
  local key="$1"
  ensure_node_runtime
  "$NODE" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$STATE_PATH" "$key"
}

write_state() {
  local port="$1"
  local injector_pid="$2"
  local injector_started_at="$3"
  local codex_pid="$4"
  local session="${5:-applying}"
  local node_ver="${NODE_VERSION:-unknown}"
  local bundle="${CODEX_BUNDLE:-}"
  local exe="${CODEX_EXE:-}"
  local app_ver="${CODEX_VERSION:-}"
  local team="${CODEX_TEAM_ID:-}"
  "$NODE" -e '
    const fs = require("node:fs");
    const [file, version, port, pid, startedAt, injector, node, nodeVersion, bundle, exe, appVersion, teamId, root, themeDir, codexPid, arch, session] = process.argv.slice(1);
    const state = {
      schemaVersion: 4,
      platform: `darwin-${arch}`,
      skinVersion: version,
      injectorProtocol: 3,
      port: Number(port),
      injectorPid: Number(pid),
      injectorStartedAt: startedAt,
      injectorPath: injector,
      nodePath: node,
      nodeVersion,
      codexBundle: bundle,
      codexExe: exe,
      codexVersion: appVersion,
      codexTeamId: teamId,
      codexPid: Number(codexPid || 0),
      projectRoot: root,
      themeDir,
      session,
      injectorMode: "full",
      createdAt: new Date().toISOString()
    };
    if (session === "active") {
      try {
        const theme = JSON.parse(fs.readFileSync(`${themeDir}/theme.json`, "utf8"));
        state.appliedThemeId = String(theme.id || "");
        state.appliedThemeName = String(theme.name || theme.id || "");
        state.verifiedAt = new Date().toISOString();
      } catch {}
    }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$STATE_PATH" "$SKIN_VERSION" "$port" "$injector_pid" "$injector_started_at" "$INJECTOR" "$NODE" "$node_ver" "$bundle" "$exe" "$app_ver" "$team" "$PROJECT_ROOT" "$THEME_DIR" "$codex_pid" "$(/usr/bin/uname -m)" "$session"
}

mark_state_active() {
  [ -f "$STATE_PATH" ] || return 1
  "$NODE" -e '
    const fs = require("node:fs");
    const [file, themeDir] = process.argv.slice(1);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const theme = JSON.parse(fs.readFileSync(`${themeDir}/theme.json`, "utf8"));
    state.session = "active";
    state.appliedThemeId = String(theme.id || "");
    state.appliedThemeName = String(theme.name || theme.id || "");
    state.injectorMode = "full";
    delete state.pausedAt;
    state.verifiedAt = new Date().toISOString();
    state.updatedAt = state.verifiedAt;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$STATE_PATH" "$THEME_DIR"
}

mark_state_stale() {
  [ -f "$STATE_PATH" ] || return 0
  "$NODE" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.session = "stale";
    state.updatedAt = new Date().toISOString();
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$STATE_PATH"
}

stop_recorded_injector() {
  [ -f "$STATE_PATH" ] || return 0
  local pid
  local saved_port
  local saved_start
  local saved_node
  local saved_injector
  if ! pid="$(state_field injectorPid 2>/dev/null)" || [ -z "${pid:-}" ]; then
    printf 'Dream Skin state is damaged or missing its injector PID; state was preserved.\n' >&2
    return 1
  fi
  # Already paused / no daemon
  if [ "$pid" = "0" ]; then
    remove_injector_launchd_job
    return 0
  fi
  case "$pid" in
    *[!0-9]*|??????????*)
      printf 'Recorded Dream Skin injector PID is invalid; state was preserved.\n' >&2
      return 1
      ;;
  esac
  while [ "${pid#0}" != "$pid" ]; do pid="${pid#0}"; done
  if [ -z "$pid" ]; then
    remove_injector_launchd_job
    return 0
  fi

  # Load and validate every recorded identity field before probing or
  # signalling the PID.  Missing fields are not treated as a harmless legacy
  # state: preserving the evidence is safer than guessing which process is
  # allowed to receive TERM/KILL.
  saved_port="$(state_field port 2>/dev/null || true)"
  saved_start="$(state_field injectorStartedAt 2>/dev/null || true)"
  saved_node="$(state_field nodePath 2>/dev/null || true)"
  saved_injector="$(state_field injectorPath 2>/dev/null || true)"
  case "$saved_port" in
    ''|*[!0-9]*)
      printf 'Recorded Dream Skin injector port is missing or invalid; state was preserved.\n' >&2
      return 1
      ;;
  esac
  [ "$saved_port" -ge 1024 ] && [ "$saved_port" -le 65535 ] || {
    printf 'Recorded Dream Skin injector port is out of range; state was preserved.\n' >&2
    return 1
  }
  if [ -z "$saved_start" ] || [ -z "$saved_node" ] || [ -z "$saved_injector" ]; then
    printf 'Recorded Dream Skin injector identity is incomplete; state was preserved.\n' >&2
    return 1
  fi
  /bin/kill -0 "$pid" 2>/dev/null || {
    remove_injector_launchd_job
    return 0
  }
  if ! recorded_injector_process_matches "$pid" "$saved_start" "$saved_node" "$saved_injector" "$saved_port"; then
    # The process may have exited between the initial kill -0 probe and the
    # identity check. A dead (or already reaped) recorded PID is safe to
    # forget; a live PID with mismatched identity is never signalled.
    if ! /bin/kill -0 "$pid" 2>/dev/null || [ -z "$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)" ]; then
      remove_injector_launchd_job
      return 0
    fi
    printf 'Recorded injector PID %s is live but its identity does not match; refusing to signal it.\n' "$pid" >&2
    return 1
  fi
  remove_injector_launchd_job
  /bin/kill -TERM "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + 6))
  while recorded_injector_process_matches "$pid" "$saved_start" "$saved_node" "$saved_injector" "$saved_port" \
    && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.2
  done
  if recorded_injector_process_matches "$pid" "$saved_start" "$saved_node" "$saved_injector" "$saved_port"; then
    /bin/kill -KILL "$pid" 2>/dev/null || true
  fi
  deadline=$((SECONDS + 2))
  while recorded_injector_process_matches "$pid" "$saved_start" "$saved_node" "$saved_injector" "$saved_port" \
    && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.1
  done
  if recorded_injector_process_matches "$pid" "$saved_start" "$saved_node" "$saved_injector" "$saved_port"; then
    printf 'Could not stop the recorded Dream Skin injector (PID %s).\n' "$pid" >&2
    return 1
  fi
  return 0
}

remove_injector_launchd_job() {
  local plist="$STATE_ROOT/$INJECTOR_JOB_LABEL.plist"
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$INJECTOR_JOB_LABEL" >/dev/null 2>&1 \
    || /bin/launchctl remove "$INJECTOR_JOB_LABEL" >/dev/null 2>&1 \
    || true
  /bin/rm -f "$plist"
}

launch_injector_daemon() {
  local port="$1"
  local pid=""
  local deadline=$((SECONDS + 10))
  local plist="$STATE_ROOT/$INJECTOR_JOB_LABEL.plist"
  local temporary="$plist.$$.tmp"
  local arguments_json=""
  local background_flag=""
  if codex_background_playback_capable; then
    background_flag="--background-playback-capable"
  fi
  : > "$INJECTOR_LOG"
  : > "$INJECTOR_ERROR_LOG"
  remove_injector_launchd_job

  # A plist-backed RunAtLoad job survives the menu action that started it but
  # deliberately has KeepAlive=false. If the watcher crashes, injection stops
  # once instead of entering a relaunch loop.
  arguments_json="$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
    "$NODE" "$INJECTOR" --watch --port "$port" --theme-dir "$THEME_DIR" \
    --theme-library "$STATE_ROOT/themes" \
    --settings "$STATE_ROOT/dynamic-settings.json" \
    ${background_flag:+"$background_flag"} \
    --operation-state "$OPERATION_STATE_PATH" --operation-ack "$OPERATION_ACK_PATH")"
  /bin/rm -f "$temporary"
  if /usr/bin/plutil -create xml1 "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert Label -string "$INJECTOR_JOB_LABEL" "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert ProgramArguments -json "$arguments_json" "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert RunAtLoad -bool true "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert KeepAlive -bool false "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert ProcessType -string Background "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert StandardOutPath -string "$INJECTOR_LOG" "$temporary" >/dev/null 2>&1 \
    && /usr/bin/plutil -insert StandardErrorPath -string "$INJECTOR_ERROR_LOG" "$temporary" >/dev/null 2>&1 \
    && /bin/chmod 600 "$temporary" \
    && /bin/mv -f "$temporary" "$plist" \
    && /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$plist" >/dev/null 2>&1; then
    while [ "$SECONDS" -lt "$deadline" ]; do
      pid="$(/bin/launchctl print "gui/$(/usr/bin/id -u)/$INJECTOR_JOB_LABEL" 2>/dev/null \
        | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}')"
      if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
        printf '%s\n' "$pid"
        return 0
      fi
      /bin/sleep 0.2
    done
    remove_injector_launchd_job
  fi
  /bin/rm -f "$temporary"

  # Fallback remains one-shot as well; there is no launchd KeepAlive owner.
  /usr/bin/nohup "$NODE" "$INJECTOR" --watch --port "$port" --theme-dir "$THEME_DIR" \
    --theme-library "$STATE_ROOT/themes" \
    --settings "$STATE_ROOT/dynamic-settings.json" \
    ${background_flag:+"$background_flag"} \
    --operation-state "$OPERATION_STATE_PATH" --operation-ack "$OPERATION_ACK_PATH" \
    >>"$INJECTOR_LOG" 2>>"$INJECTOR_ERROR_LOG" &
  pid="$!"
  /bin/sleep 0.15
  if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    return 0
  fi
  fail "The injector did not start. See $INJECTOR_ERROR_LOG and $INJECTOR_LOG"
}

# Resolve Node only through the discovered and signed official ChatGPT bundle.
ensure_node_runtime() {
  if [ "$DREAM_SKIN_VALIDATED_RUNTIME_PID" = "$$" ] \
    && [ -n "$DREAM_SKIN_VALIDATED_RUNTIME_NODE" ] \
    && [ "${NODE:-}" = "$DREAM_SKIN_VALIDATED_RUNTIME_NODE" ] \
    && [ "${CODEX_BUNDLE:-}" = "$DREAM_SKIN_VALIDATED_RUNTIME_BUNDLE" ] \
    && [ "${CODEX_EXE:-}" = "$DREAM_SKIN_VALIDATED_RUNTIME_EXE" ]; then
    return 0
  fi
  discover_codex_app
  require_signed_node_runtime
}

# Fast path when CDP is already open: replace the sole watcher and let that
# owner perform the injection. A separate --once process used to overwrite the
# live watcher with a library-incomplete payload, leaving two generations to
# fight over the same renderer and causing recurring theme flashes.
# Returns 0 on success, 1 if CDP is not ready (caller should full-start).
hot_reapply_theme() {
  local port="${1:-9341}"
  local timeout_ms="${2:-8000}"
  local operation_token="${3:-}"
  local inj_pid=""
  local started_at=""
  local codex_pid=""

  # A generic HTTP listener is not enough for a hot re-apply: only use the
  # endpoint already verified as belonging to the official Codex process.
  ensure_node_runtime || return 1
  verified_cdp_endpoint "$port" || return 1
  [ -n "$operation_token" ] || operation_token="$(new_operation_token)"
  write_operation_state applying "$(dreamskin_text applying_selected_theme)" "$operation_token" || return 1
  # Stop the exact recorded owner before replacing it. Never layer a one-shot
  # payload on top of a watcher-owned renderer.
  stop_recorded_injector 2>/dev/null || return 1
  inj_pid="$(launch_injector_daemon "$port")"
  /bin/kill -0 "$inj_pid" 2>/dev/null || return 1
  started_at="$(process_started_at "$inj_pid")"
  codex_pid="$(codex_main_pids 2>/dev/null | /usr/bin/head -n 1)"
  [ -n "$started_at" ] || started_at="$(/bin/date)"
  write_state "$port" "$inj_pid" "$started_at" "${codex_pid:-0}" active
  local current_theme_dir
  current_theme_dir="$(resolve_current_theme_dir)" || return 1
  if ! run_injector_verify "$port" "$current_theme_dir" "$timeout_ms" >/dev/null 2>&1; then
    stop_recorded_injector 2>/dev/null || true
    return 1
  fi
  mark_state_active || return 1
  write_operation_state success "$(dreamskin_text skin_applied)" "$operation_token" || return 1
  return 0
}

# Verification must reconstruct exactly the payload owned by the watcher. Keep
# these arguments in one place so every release path includes the library,
# shared settings, storage preference, and launch-time background capability.
run_injector_verify() {
  local port="$1"
  local theme_dir="$2"
  local timeout_ms="$3"
  local background_flag=""
  shift 3
  if codex_background_playback_capable; then
    background_flag="--background-playback-capable"
  fi
  "$NODE" "$INJECTOR" --verify \
    --port "$port" \
    --theme-dir "$theme_dir" \
    --theme-library "$STATE_ROOT/themes" \
    --settings "$STATE_ROOT/dynamic-settings.json" \
    ${background_flag:+"$background_flag"} \
    --timeout-ms "$timeout_ms" \
    "$@"
}

# Always tear down any leftover launchd babysitter for the themed Codex process.
# Older builds used `launchctl submit` which can relaunch Codex after the user quits
# or after SwiftBar exits — that is unexpected and unwanted.
release_codex_launchd_job() {
  /bin/launchctl remove "gui/$(/usr/bin/id -u)/$CODEX_APP_JOB_LABEL" >/dev/null 2>&1 || true
  /bin/launchctl remove "$CODEX_APP_JOB_LABEL" >/dev/null 2>&1 || true
}

launch_codex_with_cdp() {
  local port="$1"
  local launch_args=(
    "--remote-debugging-address=127.0.0.1"
    "--remote-debugging-port=$port"
  )
  if dynamic_background_playback_enabled; then
    launch_args+=(
      "--disable-background-media-suspend"
      "--disable-backgrounding-occluded-windows"
      "--disable-background-timer-throttling"
      "--disable-renderer-backgrounding"
    )
  fi
  : > "$APP_LOG"
  : > "$APP_ERROR_LOG"
  release_codex_launchd_job
  # Pass Chromium switches at process creation: a successful LaunchServices
  # request does not prove the resulting process retained them. Launch the
  # signed executable once, preserving the normal default profile. Do not use
  # launchctl submit, which can reopen Codex after the user quits.
  /usr/bin/nohup "$CODEX_EXE" "${launch_args[@]}" \
    >>"$APP_LOG" 2>>"$APP_ERROR_LOG" &
}

launch_codex_normally() {
  release_codex_launchd_job
  /usr/bin/open -na "$CODEX_BUNDLE"
}
