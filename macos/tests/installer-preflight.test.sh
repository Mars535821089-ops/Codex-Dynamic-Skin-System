#!/bin/bash

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

# Desktop artifacts are opt-in. A normal installation must not silently place
# launchers in the user's personal Desktop directory.
/usr/bin/grep -F -q 'CREATE_LAUNCHERS="false"' \
  "$ROOT/scripts/install-dream-skin-macos.sh"
/usr/bin/grep -F -q -- '--launchers) CREATE_LAUNCHERS="true"' \
  "$ROOT/scripts/install-dream-skin-macos.sh"

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf 'SKIP: installer preflight integration requires macOS.\n'
  exit 0
fi

TMP="$(/usr/bin/mktemp -d /tmp/dreamskin-installer-preflight.XXXXXX)"
DUMMY_PID=""
stop_dummy() {
  [ -n "$DUMMY_PID" ] || return 0
  /bin/kill "$DUMMY_PID" 2>/dev/null || true
  wait "$DUMMY_PID" 2>/dev/null || true
  DUMMY_PID=""
}
cleanup() {
  stop_dummy
  /bin/chmod -R u+w "$TMP" 2>/dev/null || true
  /bin/rm -rf "$TMP"
}
trap cleanup EXIT

TEST_HOME="$TMP/home"
FAKE_APP="$TMP/FakeChatGPT.app"
FAKE_EXE="$FAKE_APP/Contents/MacOS/ChatGPT"
FAKE_PLIST="$FAKE_APP/Contents/Info.plist"
LIVE_ENGINE="$TEST_HOME/.codex/codex-dream-skin-studio"
OUTPUT="$TMP/install-output.txt"

/bin/mkdir -p "$FAKE_APP/Contents/MacOS" "$TEST_HOME/.codex" "$LIVE_ENGINE"
/usr/bin/printf '%s\n' \
  '#include <signal.h>' \
  '#include <unistd.h>' \
  'static void stop(int signal_number) { (void)signal_number; _exit(0); }' \
  'int main(void) { signal(SIGTERM, stop); for (;;) pause(); }' \
  > "$TMP/fake-chatgpt.c"
if ! /usr/bin/xcrun clang -Os -o "$FAKE_EXE" "$TMP/fake-chatgpt.c" \
  2>"$TMP/clang-error.txt"; then
  /bin/cat "$TMP/clang-error.txt" >&2
  exit 1
fi
/usr/bin/plutil -create xml1 "$FAKE_PLIST"
/usr/bin/plutil -insert CFBundleIdentifier -string com.openai.codex "$FAKE_PLIST"
/usr/bin/plutil -insert CFBundleExecutable -string ChatGPT "$FAKE_PLIST"
/usr/bin/plutil -insert CFBundleShortVersionString -string 99.0.0 "$FAKE_PLIST"
/usr/bin/printf '%s\n' 'previous-engine' > "$LIVE_ENGINE/old-engine-marker"

# A closed app reaches the inner signed-runtime gate. That intentional failure
# must not emit an unbound-variable error or replace the previous engine.
if /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$TEST_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$ROOT/scripts/install-dream-skin-macos.sh" --no-launchers --no-launch \
  >"$OUTPUT" 2>&1; then
  printf 'Unsigned fixture unexpectedly completed engine installation.\n' >&2
  exit 1
fi
if /usr/bin/grep -F -q 'unbound variable' "$OUTPUT"; then
  printf 'Outer installer used an app variable before discovery.\n' >&2
  exit 1
fi
[ -f "$LIVE_ENGINE/old-engine-marker" ]
[ ! -f "$LIVE_ENGINE/VERSION" ]
[ -z "$(/usr/bin/find "$TEST_HOME/.codex" -maxdepth 1 \
  \( -name 'codex-dream-skin-studio.installing.*' \
  -o -name 'codex-dream-skin-studio.previous.*' \
  -o -name 'codex-dream-skin-studio.broken.*' \) -print -quit)" ]

# A process whose command and executable both match the discovered app must be
# rejected before deploy_project can move or copy any engine bytes.
"$FAKE_EXE" 120 &
DUMMY_PID="$!"
for _ in 1 2 3 4 5; do
  /usr/sbin/lsof -a -p "$DUMMY_PID" -d txt -Fn 2>/dev/null \
    | /usr/bin/grep -F -q "n$FAKE_EXE" && break
  /bin/sleep 0.1
done
/bin/kill -0 "$DUMMY_PID"
/bin/chmod 500 "$TEST_HOME/.codex"
if /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$TEST_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$ROOT/scripts/install-dream-skin-macos.sh" --no-launchers --no-launch \
  >"$OUTPUT" 2>&1; then
  printf 'Installer continued while the discovered app executable was running.\n' >&2
  exit 1
fi
/bin/chmod 700 "$TEST_HOME/.codex"
/usr/bin/grep -F -q 'Close Codex before installation' "$OUTPUT"
[ -f "$LIVE_ENGINE/old-engine-marker" ]
[ ! -f "$LIVE_ENGINE/VERSION" ]
[ -z "$(/usr/bin/find "$TEST_HOME/.codex" -maxdepth 1 \
  \( -name 'codex-dream-skin-studio.installing.*' \
  -o -name 'codex-dream-skin-studio.previous.*' \
  -o -name 'codex-dream-skin-studio.broken.*' \) -print -quit)" ]

# Updating only the managed engine must remain available while Codex is open:
# this path does not touch config.toml, Desktop, launch, activate, or terminate
# the running app. It is the safe way to stage a fix for the next normal start.
if ! /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$TEST_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$ROOT/scripts/install-dream-skin-macos.sh" --engine-only --port 19342 \
  >"$OUTPUT" 2>&1; then
  /bin/cat "$OUTPUT" >&2
  printf 'Engine-only installation failed while Codex was running.\n' >&2
  exit 1
fi
/bin/kill -0 "$DUMMY_PID"
[ -f "$LIVE_ENGINE/VERSION" ]
[ ! -f "$LIVE_ENGINE/old-engine-marker" ]
/usr/bin/grep -F -q 'No Desktop files were created' "$OUTPUT"
[ -z "$(/usr/bin/find "$TEST_HOME/Desktop" -maxdepth 1 -type f -print -quit 2>/dev/null)" ]
[ ! -e "$TEST_HOME/.codex/config.toml" ]
[ ! -e "$TEST_HOME/Library/Application Support/CodexDreamSkinStudio/state.json" ]

# Legacy launchers remain explicit opt-in and may also be refreshed safely
# while Codex is open.
if ! /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$TEST_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$ROOT/scripts/install-dream-skin-macos.sh" --launchers-only --port 19342 \
  >"$OUTPUT" 2>&1; then
  /bin/cat "$OUTPUT" >&2
  printf 'Launcher-only installation failed while Codex was running.\n' >&2
  exit 1
fi
/bin/kill -0 "$DUMMY_PID"
/usr/bin/grep -F -q '# CodexDreamSkinStudio launcher' \
  "$TEST_HOME/Desktop/Codex Dream Skin.command"
/usr/bin/grep -F -q -- '--port 19342 --prompt-restart' \
  "$TEST_HOME/Desktop/Codex Dream Skin.command"
[ ! -e "$TEST_HOME/.codex/config.toml" ]
[ ! -e "$TEST_HOME/Library/Application Support/CodexDreamSkinStudio/state.json" ]
stop_dummy

printf 'PASS: macOS outer installer discovers the app before guarding and rolls back failed deployment.\n'
