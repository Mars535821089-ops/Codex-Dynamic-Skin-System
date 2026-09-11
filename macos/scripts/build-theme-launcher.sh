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
preserve_signature_from=""

fail() { printf 'Codex Theme Launcher build: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --engine-root|--output|--port|--icon-source|--sign-identity|--preserve-signature-from)
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
        --preserve-signature-from) preserve_signature_from="$value" ;;
      esac
      ;;
    --help)
      printf '%s\n' 'Usage: build-theme-launcher.sh [--engine-root ABSOLUTE_PATH] [--output ABSOLUTE_APP_PATH] [--port 9341] [--icon-source ABSOLUTE_ICNS_PATH] [--sign-identity IDENTITY] [--preserve-signature-from EXISTING_APP]' \
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
preserved_requirement=""
available_identities() {
  /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]{40}).*$/\1/p' || true
}
if [ -n "$preserve_signature_from" ]; then
  case "$preserve_signature_from" in /*.app) ;; *) fail '--preserve-signature-from must be an absolute .app path.' ;; esac
  [ -d "$preserve_signature_from" ] && [ ! -L "$preserve_signature_from" ] \
    || fail 'The existing launcher must be a regular application directory, not a symlink.'
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$preserve_signature_from/Contents/Info.plist" 2>/dev/null || true)" = io.github.codex-dynamic-skin-system.launcher ] \
    || fail 'Cannot preserve the signature of an unrelated application.'
  /usr/bin/codesign --verify --deep --strict "$preserve_signature_from" >/dev/null 2>&1 \
    || fail 'The existing launcher signature is invalid; leaving it unchanged.'
  signature_details="$(/usr/bin/codesign -dvv "$preserve_signature_from" 2>&1)"
  if ! printf '%s\n' "$signature_details" | /usr/bin/grep -q '^Signature=adhoc$'; then
    /usr/bin/codesign -d --extract-certificates="$staging/previous-cert-" "$preserve_signature_from" >/dev/null 2>&1 \
      || fail 'Cannot read the existing launcher signing certificate.'
    [ -f "$staging/previous-cert-0" ] || fail 'The existing launcher signing certificate is missing.'
    required_identity="$(/usr/bin/shasum -a 1 "$staging/previous-cert-0" | /usr/bin/awk '{print toupper($1)}')"
    [ -z "$sign_identity" ] || [ "$(printf '%s' "$sign_identity" | /usr/bin/tr '[:lower:]' '[:upper:]')" = "$required_identity" ] \
      || fail 'Cannot override the existing launcher signing identity during an upgrade.'
    available_identities | /usr/bin/grep -Fxq "$required_identity" \
      || fail 'The existing launcher signing identity is unavailable; restore its certificate and private key in Keychain. The installed app is unchanged.'
    sign_identity="$required_identity"
    preserved_requirement="$(/usr/bin/codesign -d -r- "$preserve_signature_from" 2>/dev/null | /usr/bin/sed -n 's/^designated => //p')"
    [ -n "$preserved_requirement" ] || fail 'Cannot read the existing launcher designated requirement.'
  fi
fi
# New installations and existing ad-hoc launchers may choose an available
# identity. An already certificate-signed launcher must never reach fallback.
if [ -z "$sign_identity" ]; then
  sign_identity="$(available_identities | /usr/bin/sed -n '1p')"
fi
app="$staging/Codex Theme Launcher.app"
/bin/mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
/bin/cp "$source_root/Info.plist" "$app/Contents/Info.plist"
[ -z "$icon_source" ] || /bin/cp "$icon_source" "$app/Contents/Resources/CodexThemeLauncher.icns"
/usr/bin/plutil -replace CDSSEngineRoot -string "$engine_root" "$app/Contents/Info.plist"
/usr/bin/plutil -replace CDSSPort -integer "$port" "$app/Contents/Info.plist"
/usr/bin/xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx12.0" -framework AppKit \
  "$source_root/ThemeLauncher.swift" -o "$app/Contents/MacOS/CodexThemeLauncher"
/usr/bin/plutil -lint "$app/Contents/Info.plist" >/dev/null
# Keep the existing designated requirement, including any caller-supplied
# clauses, instead of relying on codesign to regenerate an equivalent one.
sign_arguments=(--force --timestamp=none --sign "${sign_identity:--}")
[ -z "$preserved_requirement" ] || sign_arguments+=(--requirements "=designated => $preserved_requirement")
/usr/bin/codesign "${sign_arguments[@]}" "$app" >/dev/null 2>&1 \
  || fail 'Launcher signing failed; the requested identity may be unavailable or inaccessible. No application was installed.'
/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 \
  || fail 'The newly built launcher signature did not verify.'
if [ -n "$preserved_requirement" ]; then
  new_requirement="$(/usr/bin/codesign -d -r- "$app" 2>/dev/null | /usr/bin/sed -n 's/^designated => //p')"
  [ "$new_requirement" = "$preserved_requirement" ] \
    || fail 'The launcher designated requirement changed; refusing to publish the update.'
  /usr/bin/codesign --verify --strict --test-requirement "=$preserved_requirement" "$app" >/dev/null 2>&1 \
    || fail 'The update does not satisfy the existing launcher designated requirement.'
fi
# Reserve the exact output atomically so concurrent builders cannot nest one
# .app inside the other or replace an output that appeared during compilation.
/bin/mkdir "$output" || fail "Output appeared during build; refusing to replace it: $output"
if ! /bin/mv "$app/Contents" "$output/Contents"; then
  /bin/rmdir "$output" 2>/dev/null || true
  fail "Could not publish launcher contents at $output"
fi
printf '%s\n' "$output"
