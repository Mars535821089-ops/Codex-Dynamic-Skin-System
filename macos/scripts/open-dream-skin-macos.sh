#!/bin/bash

set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

PORT=9341
PORT_EXPLICIT="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$PORT_EXPLICIT" = "false" ] || fail "Port may only be specified once."
      [ "$#" -ge 2 ] || fail "Missing value for --port."
      PORT="$2"
      PORT_EXPLICIT="true"
      shift 2
      ;;
    *) fail "Unknown open argument: $1" ;;
  esac
done

case "$PORT" in
  ''|0*|*[!0-9]*) fail "Invalid port: $PORT" ;;
esac
[ "${#PORT}" -le 5 ] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] \
  || fail "Port must be between 1024 and 65535."

discover_codex_app

# Reopening the icon must leave the running app and its watcher lifecycle alone.
if codex_is_running; then
  /usr/bin/open -a "$CODEX_BUNDLE"
  exit 0
fi

# A closed app follows the existing startup path using its regular profile.
exec /bin/bash "$SCRIPT_DIR/start-dream-skin-macos.sh" --port "$PORT"
