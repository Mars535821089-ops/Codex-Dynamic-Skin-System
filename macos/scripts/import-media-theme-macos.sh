#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common-macos.sh"
discover_codex_app
require_signed_node_runtime
exec "$NODE" "$SCRIPT_DIR/import-media-theme-macos.mjs" "$@"
