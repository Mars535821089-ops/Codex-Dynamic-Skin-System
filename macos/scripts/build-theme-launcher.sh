#!/bin/bash
set -euo pipefail

script_root="$(cd "$(dirname "$0")" && pwd -P)"
source_root="$(cd "$script_root/../launcher" && pwd -P)"
repository_root="$(cd "$script_root/../.." && pwd -P)"
engine_root="$HOME/.codex/codex-dream-skin-studio"
output="$HOME/Applications/Codex Theme Launcher.app"
port=9341
icon_source=""
sign_identity="${CDSS_CODESIGN_IDENTITY:-}"

fail() { printf 'Codex Theme Launcher build: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --engine-root|--output|--port|--icon-source|--sign-identity)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      option="$1"
      value="$2"
      shift 2
      case "$option" in
        --engine-root) engine_root="$value" ;;
        --output) output="$value" ;;
        --port) port="$value" ;;
        --icon-source) icon_source="$value" ;;
        --sign-identity) sign_identity="$value" ;;
      esac
      ;;
    --help)
      printf '%s\n' 'Usage: build-theme-launcher.sh [--engine-root ABSOLUTE_PATH] [--output ABSOLUTE_APP_PATH] [--port 9341] [--icon-source ABSOLUTE_ICNS_PATH] [--sign-identity IDENTITY]' \
        'Builds a standalone application without launching it. Existing output paths are refused.'
      exit 0
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || fail 'This builder requires macOS and the Xcode command line tools.'
case "$engine_root" in /*) ;; *) fail '--engine-root must be absolute.' ;; esac
[ "$engine_root" != / ] || fail '--engine-root cannot be the filesystem root.'
case "$output" in /*.app) ;; *) fail '--output must be an absolute .app path.' ;; esac
case "$port" in ''|*[!0-9]*) fail '--port must be an integer between 1024 and 65535.' ;; esac
[ "${#port}" -le 5 ] || fail '--port must be between 1024 and 65535.'
port="$((10#$port))"
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || fail '--port must be between 1024 and 65535.'
[ ! -e "$output" ] && [ ! -L "$output" ] || fail "Output already exists; choose a new path: $output"
if [ -n "$icon_source" ]; then
  case "$icon_source" in /*.icns) ;; *) fail '--icon-source must be an absolute .icns path.' ;; esac
  [ -f "$icon_source" ] && [ ! -L "$icon_source" ] || fail '--icon-source must be a regular non-symlink file.'
fi
/bin/mkdir -p "$(dirname "$output")"
output_parent="$(cd "$(dirname "$output")" && pwd -P)"
case "$output_parent/" in "$repository_root/"*) fail 'Build output must be outside the source repository.' ;; esac
output="$output_parent/$(basename "$output")"

staging="$(/usr/bin/mktemp -d "$output_parent/.theme-launcher-build.XXXXXX")"
cleanup() { [ -z "${staging:-}" ] || /bin/rm -rf "$staging"; }
trap cleanup EXIT
app="$staging/Codex Theme Launcher.app"
/bin/mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
/bin/cp "$source_root/Info.plist" "$app/Contents/Info.plist"
[ -z "$icon_source" ] || /bin/cp "$icon_source" "$app/Contents/Resources/CodexThemeLauncher.icns"
/usr/bin/plutil -replace CDSSEngineRoot -string "$engine_root" "$app/Contents/Info.plist"
/usr/bin/plutil -replace CDSSPort -integer "$port" "$app/Contents/Info.plist"
/usr/bin/xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx12.0" -framework AppKit \
  "$source_root/ThemeLauncher.swift" -o "$app/Contents/MacOS/CodexThemeLauncher"
/usr/bin/plutil -lint "$app/Contents/Info.plist" >/dev/null
# Prefer a stable local signing identity. macOS privacy approvals are keyed to
# the app's designated requirement; an ad-hoc rebuild changes its cdhash and
# can otherwise make the same launcher look like a different app.
if [ -z "$sign_identity" ]; then
  sign_identity="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]{40}).*$/\1/p' \
    | /usr/bin/head -n 1)"
fi
if [ -n "$sign_identity" ]; then
  /usr/bin/codesign --force --timestamp=none --sign "$sign_identity" "$app" >/dev/null
else
  /usr/bin/codesign --force --timestamp=none --sign - "$app" >/dev/null
fi
# Reserve the exact output atomically so concurrent builders cannot nest one
# .app inside the other or replace an output that appeared during compilation.
/bin/mkdir "$output" || fail "Output appeared during build; refusing to replace it: $output"
if ! /bin/mv "$app/Contents" "$output/Contents"; then
  /bin/rmdir "$output" 2>/dev/null || true
  fail "Could not publish launcher contents at $output"
fi
printf '%s\n' "$output"
