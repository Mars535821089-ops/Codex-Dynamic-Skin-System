#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

PORT=9341
PORT_EXPLICIT="false"
SCREENSHOT=""
RELOAD="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; PORT_EXPLICIT="true"; shift 2 ;;
    --screenshot) SCREENSHOT="${2:-}"; shift 2 ;;
    --reload) RELOAD="true"; shift ;;
    *) fail "Unknown verify argument: $1" ;;
  esac
done

discover_codex_app
require_macos_runtime
if [ "$PORT_EXPLICIT" = "false" ] && [ -f "$STATE_PATH" ]; then
  PORT="$(state_field port)"
fi
verified_cdp_endpoint "$PORT" || fail "Port $PORT is not a verified Codex loopback CDP endpoint."
CURRENT_THEME_DIR="$(resolve_current_theme_dir)" || fail "Could not resolve the currently selected theme."

if [ -n "$SCREENSHOT" ] && [ "$RELOAD" = "true" ]; then
  run_injector_verify "$PORT" "$CURRENT_THEME_DIR" 30000 --screenshot "$SCREENSHOT" --reload
elif [ -n "$SCREENSHOT" ]; then
  run_injector_verify "$PORT" "$CURRENT_THEME_DIR" 30000 --screenshot "$SCREENSHOT"
elif [ "$RELOAD" = "true" ]; then
  run_injector_verify "$PORT" "$CURRENT_THEME_DIR" 30000 --reload
else
  run_injector_verify "$PORT" "$CURRENT_THEME_DIR" 30000
fi
