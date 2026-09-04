#!/bin/bash

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(/usr/bin/mktemp -d /tmp/dreamskin-state-persistence.XXXXXX)"
cleanup() {
  /bin/chmod -R u+w "$TMP" 2>/dev/null || true
  /bin/rm -rf "$TMP"
}
trap cleanup EXIT

TEST_HOME="$TMP/home"
STATE_ROOT="$TEST_HOME/Library/Application Support/CodexDreamSkinStudio"
CUSTOM_THEME="$STATE_ROOT/themes/com.mars.imported-video"
SETTINGS="$STATE_ROOT/dynamic-settings.json"
/bin/mkdir -p "$CUSTOM_THEME"
/usr/bin/printf '%s\n' '{"schemaVersion":2,"id":"com.mars.imported-video"}' > "$CUSTOM_THEME/theme.json"
/usr/bin/printf '%s\n' '{"schemaVersion":1,"backgroundPlayback":true}' > "$SETTINGS"
THEME_HASH_BEFORE="$(/usr/bin/shasum -a 256 "$CUSTOM_THEME/theme.json" | /usr/bin/awk '{print $1}')"
SETTINGS_HASH_BEFORE="$(/usr/bin/shasum -a 256 "$SETTINGS" | /usr/bin/awk '{print $1}')"

HOME="$TEST_HOME" /bin/bash -c '
  set -euo pipefail
  . "$1/scripts/common-macos.sh"
  ensure_state_root
  seed_bundled_presets
' _ "$ROOT"

[ -f "$CUSTOM_THEME/theme.json" ] || { printf 'Imported theme was removed while seeding bundled presets.\n' >&2; exit 1; }
[ -f "$SETTINGS" ] || { printf 'Dynamic settings were removed while seeding bundled presets.\n' >&2; exit 1; }
[ "$(/usr/bin/shasum -a 256 "$CUSTOM_THEME/theme.json" | /usr/bin/awk '{print $1}')" = "$THEME_HASH_BEFORE" ] \
  || { printf 'Imported theme changed while seeding bundled presets.\n' >&2; exit 1; }
[ "$(/usr/bin/shasum -a 256 "$SETTINGS" | /usr/bin/awk '{print $1}')" = "$SETTINGS_HASH_BEFORE" ] \
  || { printf 'Background-playback settings changed while seeding bundled presets.\n' >&2; exit 1; }

printf 'PASS: Mac upgrades preserve imported themes and dynamic settings.\n'
