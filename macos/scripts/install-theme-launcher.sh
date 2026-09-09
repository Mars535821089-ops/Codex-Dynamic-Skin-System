#!/bin/bash
set -euo pipefail
umask 077

script_root="$(cd "$(dirname "$0")" && pwd -P)"
engine_root="$HOME/.codex/codex-dream-skin-studio"
applications_dir="$HOME/Applications"
desktop_dir="$HOME/Desktop"
state_dir="$HOME/Library/Application Support/CodexDreamSkinStudio/launcher"
codex_app=""
port=9341
desktop=false
dock=false
fail() { printf 'Codex Theme Launcher install: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --engine-root|--applications-dir|--desktop-dir|--state-dir|--codex-app|--port)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      option="$1"; value="$2"; shift 2
      case "$option" in
        --engine-root) engine_root="$value" ;;
        --applications-dir) applications_dir="$value" ;;
        --desktop-dir) desktop_dir="$value" ;;
        --state-dir) state_dir="$value" ;;
        --codex-app) codex_app="$value" ;;
        --port) port="$value" ;;
      esac ;;
    --desktop) desktop=true; shift ;;
    --dock) dock=true; shift ;;
    --help)
      printf '%s\n' 'Usage: install-theme-launcher.sh [--engine-root PATH] [--port N] [--desktop] [--dock --codex-app PATH.app]' \
        'Builds and installs the independent launcher. Never launches or restarts Codex.' \
        '--dock replaces only a matching pinned official app; it refreshes Dock, not Codex.'
      exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
for directory in "$engine_root" "$applications_dir" "$desktop_dir" "$state_dir"; do
  case "$directory" in /*) ;; *) fail "Paths must be absolute: $directory" ;; esac
  [ "$directory" != / ] || fail 'A filesystem root is not a valid installation directory.'
done
[ -f "$engine_root/scripts/open-dream-skin-macos.sh" ] \
  || fail 'Install the updated theme engine first (open-dream-skin-macos.sh is missing).'
target="$applications_dir/Codex Theme Launcher.app"
shortcut="$desktop_dir/Codex Theme Launcher.app"
if [ -e "$target" ] || [ -L "$target" ]; then
  [ ! -L "$target" ] && [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist" 2>/dev/null || true)" = io.github.codex-dynamic-skin-system.launcher ] \
    || fail "Refusing to overwrite an unrelated application: $target"
fi
if [ "$desktop" = true ] && { [ -e "$shortcut" ] || [ -L "$shortcut" ]; }; then
  [ -L "$shortcut" ] && [ "$(/usr/bin/readlink "$shortcut")" = "$target" ] \
    || fail "Refusing to overwrite an unrelated Desktop item: $shortcut"
fi
if [ "$dock" = true ]; then
  case "$codex_app" in /*.app) ;; *) fail '--dock requires --codex-app with the exact official app path.' ;; esac
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$codex_app/Contents/Info.plist" 2>/dev/null || true)" = com.openai.codex ] \
    || fail 'The specified official app is not Codex.'
fi
/bin/mkdir -p "$applications_dir" "$state_dir"
staging="$(/usr/bin/mktemp -d "$applications_dir/.cdss-install.XXXXXX")"
backup_dir=""
installed=false
phase="build launcher"
dock_backup=""
cleanup() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf 'Installation stopped during %s (exit %s).\n' "$phase" "$code" >&2
    if [ "$installed" = true ]; then
      printf 'New launcher remains installed: %s\n' "$target" >&2
      [ -z "$backup_dir" ] || printf 'Previous launcher retained: %s\n' "$backup_dir" >&2
    fi
    if [ -n "$dock_backup" ] && [ -f "$dock_backup" ]; then
      printf 'Dock backup retained: %s\n' "$dock_backup" >&2
    fi
  fi
  /bin/rm -rf "$staging"
  exit "$code"
}
trap cleanup EXIT
/bin/bash "$script_root/build-theme-launcher.sh" --engine-root "$engine_root" \
  --port "$port" --output "$staging/Codex Theme Launcher.app" >/dev/null
"$staging/Codex Theme Launcher.app/Contents/MacOS/CodexThemeLauncher" --check >/dev/null
phase="prepare file installer"
/usr/bin/xcrun swiftc "$script_root/../integration/LauncherFiles.swift" -o "$staging/launcher-files"
if [ "$dock" = true ]; then
  phase="prepare Dock integration"
  /usr/bin/xcrun swiftc "$script_root/../integration/DockEntry.swift" -o "$staging/dock-entry"
fi
phase="publish launcher and Desktop shortcut"
file_arguments=(install --source "$staging/Codex Theme Launcher.app" --target "$target" --state-dir "$state_dir")
if [ "$desktop" = true ]; then file_arguments+=(--shortcut "$shortcut"); fi
# The native helper holds one flock across revalidation, backup, exact-path
# publication and shortcut creation. It restores or reports backups on failure.
"$staging/launcher-files" "${file_arguments[@]}" > "$staging/install-report.json"
installed=true
backup_dir="$(/usr/bin/plutil -extract backup raw -o - "$staging/install-report.json")"
if [ "$dock" = true ]; then
  phase="update Dock shortcut"
  dock_backup="$state_dir/dock-before-$(/bin/date +%Y%m%d-%H%M%S)-$$.plist"
  report="$("$staging/dock-entry" --target "$codex_app" --launcher "$target" --apply --backup "$dock_backup")"
  printf 'Dock: %s\n' "$report"
  changed="$(printf '%s' "$report" | /usr/bin/plutil -extract changed raw -o - -)"
  if [ "$changed" -gt 0 ]; then
    printf 'Dock backup: %s\n' "$dock_backup"
    /usr/bin/killall -u "$(/usr/bin/id -un)" Dock >/dev/null 2>&1 || true
  fi
fi
printf 'Installed: %s\nNo Codex process was launched, closed, or restarted.\n' "$target"
if [ -n "$backup_dir" ]; then printf 'Previous launcher retained: %s\n' "$backup_dir"; fi
