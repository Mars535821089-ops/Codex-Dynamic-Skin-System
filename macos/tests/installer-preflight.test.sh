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

# A direct install from a dirty Git checkout must deploy only tracked project
# files. Local notes, credentials, build artifacts, and other untracked files
# must never be copied into the managed engine directory.
DIRTY_SOURCE="$TMP/dirty-source"
DIRTY_HOME="$TMP/dirty-home"
/bin/mkdir -p "$DIRTY_SOURCE" "$DIRTY_HOME/.codex"
/usr/bin/rsync -a --exclude 'release/' "$ROOT/" "$DIRTY_SOURCE/"
/usr/bin/git -C "$DIRTY_SOURCE" init -q
/usr/bin/git -C "$DIRTY_SOURCE" add --all
/usr/bin/printf 'untracked sentinel\n' > "$DIRTY_SOURCE/local-untracked-sentinel.txt"
if ! /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$DIRTY_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$DIRTY_SOURCE/scripts/install-dream-skin-macos.sh" --engine-only --port 19343 \
  >"$OUTPUT" 2>&1; then
  /bin/cat "$OUTPUT" >&2
  printf 'Engine-only installation from a dirty checkout failed.\n' >&2
  exit 1
fi
[ -f "$DIRTY_HOME/.codex/codex-dream-skin-studio/VERSION" ]
[ ! -e "$DIRTY_HOME/.codex/codex-dream-skin-studio/local-untracked-sentinel.txt" ]

# A tracked symbolic link is never a deployable installer input. Refusal must
# also leave no partial staging directory behind.
/bin/ln -s VERSION "$DIRTY_SOURCE/tracked-link"
/usr/bin/git -C "$DIRTY_SOURCE" add tracked-link
if /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$DIRTY_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$DIRTY_SOURCE/scripts/install-dream-skin-macos.sh" --engine-only --port 19343 \
  >"$OUTPUT" 2>&1; then
  printf 'Installer accepted a tracked symbolic link.\n' >&2
  exit 1
fi
/usr/bin/grep -F -q 'Tracked installer input must be a regular file' "$OUTPUT"
[ -z "$(/usr/bin/find "$DIRTY_HOME/.codex" -maxdepth 1 \
  -name 'codex-dream-skin-studio.installing.*' -print -quit)" ]

# Replacing a tracked directory with a symbolic link after it was added to Git
# must not turn its tracked child into an external installer input.
/usr/bin/git -C "$DIRTY_SOURCE" reset -q tracked-link
/bin/rm -f "$DIRTY_SOURCE/tracked-link"
/bin/mkdir -p "$DIRTY_SOURCE/tracked-parent" "$TMP/outside-tracked-parent"
/usr/bin/printf 'tracked\n' > "$DIRTY_SOURCE/tracked-parent/file.txt"
/usr/bin/git -C "$DIRTY_SOURCE" add tracked-parent/file.txt
/usr/bin/printf 'outside\n' > "$TMP/outside-tracked-parent/file.txt"
/bin/rm -rf "$DIRTY_SOURCE/tracked-parent"
/bin/ln -s "$TMP/outside-tracked-parent" "$DIRTY_SOURCE/tracked-parent"
if /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$DIRTY_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$DIRTY_SOURCE/scripts/install-dream-skin-macos.sh" --engine-only --port 19343 \
  >"$OUTPUT" 2>&1; then
  printf 'Installer accepted a tracked file through a symbolic-link directory.\n' >&2
  exit 1
fi
/usr/bin/grep -F -q 'Tracked installer input must be a regular file' "$OUTPUT"
[ -z "$(/usr/bin/find "$DIRTY_HOME/.codex" -maxdepth 1 \
  -name 'codex-dream-skin-studio.installing.*' -print -quit)" ]

# Official release directories have no .git metadata. They must carry an
# explicit install manifest so unrelated extracted files are not copied into
# the managed engine.
RELEASE_SOURCE="$TMP/release-source"
RELEASE_HOME="$TMP/release-home"
/bin/mkdir -p "$RELEASE_SOURCE" "$RELEASE_HOME/.codex"
/usr/bin/rsync -a --exclude 'release/' "$ROOT/" "$RELEASE_SOURCE/"
/usr/bin/printf 'must not install\n' > "$RELEASE_SOURCE/local-release-sentinel.txt"
(
  cd "$RELEASE_SOURCE"
  {
    /usr/bin/find . -type f \
      ! -name 'INSTALL-FILES.txt' \
      ! -name 'local-release-sentinel.txt' \
      -print | /usr/bin/sed 's#^\./##'
    /usr/bin/printf 'INSTALL-FILES.txt\n'
  } | LC_ALL=C /usr/bin/sort > INSTALL-FILES.txt
)
if ! /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$RELEASE_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$RELEASE_SOURCE/scripts/install-dream-skin-macos.sh" --engine-only --port 19344 \
  >"$OUTPUT" 2>&1; then
  /bin/cat "$OUTPUT" >&2
  printf 'Engine-only installation from a release manifest failed.\n' >&2
  exit 1
fi
[ -f "$RELEASE_HOME/.codex/codex-dream-skin-studio/VERSION" ]
[ ! -e "$RELEASE_HOME/.codex/codex-dream-skin-studio/local-release-sentinel.txt" ]

# A manifest entry reached through a symbolic-link directory is not a regular
# package input, even when the final path resolves to an ordinary file.
/bin/mkdir -p "$TMP/outside-release"
/usr/bin/printf 'outside\n' > "$TMP/outside-release/file.txt"
/bin/ln -s "$TMP/outside-release" "$RELEASE_SOURCE/linked-parent"
/usr/bin/printf 'linked-parent/file.txt\n' >> "$RELEASE_SOURCE/INSTALL-FILES.txt"
if /usr/bin/env -u CODEX_EXE -u CODEX_BUNDLE \
  HOME="$RELEASE_HOME" CODEX_APP_BUNDLE="$FAKE_APP" \
  "$RELEASE_SOURCE/scripts/install-dream-skin-macos.sh" --engine-only --port 19344 \
  >"$OUTPUT" 2>&1; then
  printf 'Release installer accepted a manifest path through a symbolic link.\n' >&2
  exit 1
fi
/usr/bin/grep -F -q 'Release manifest input must be a regular file' "$OUTPUT"
[ -z "$(/usr/bin/find "$RELEASE_HOME/.codex" -maxdepth 1 \
  -name 'codex-dream-skin-studio.installing.*' -print -quit)" ]

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
