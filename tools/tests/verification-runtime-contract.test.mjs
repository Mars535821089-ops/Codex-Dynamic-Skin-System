import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scripts = path.join(root, "macos/scripts");
const common = await fs.readFile(path.join(scripts, "common-macos.sh"), "utf8");

assert.match(common, /run_injector_verify\(\)/);
assert.match(common, /codex_process_has_background_playback_flags\(\)/);
assert.match(common, /codex_background_playback_capable\(\)/);
assert.match(common, /background_flag="--background-playback-capable"/);
assert.doesNotMatch(common, /--settings "\$STATE_ROOT\/dynamic-settings\.json" \\\n\s+--background-playback-capable/,
  "watchers and verifiers must not claim launch-time capability unconditionally");

for (const name of [
  "doctor-macos.sh",
  "start-dream-skin-macos.sh",
  "switch-theme-macos.sh",
  "verify-dream-skin-macos.sh",
]) {
  const source = await fs.readFile(path.join(scripts, name), "utf8");
  assert.match(source, /run_injector_verify/, `${name} must use the canonical watcher verification contract`);
  assert.doesNotMatch(source, /"\$NODE"\s+"\$INJECTOR"\s+--verify/,
    `${name} must not rebuild a partial verification contract`);
  assert.doesNotMatch(source, /ARGS=\(\)[\s\S]*"\$\{ARGS\[@\]\}"/,
    `${name} must not expand an empty array under macOS Bash 3.2 with nounset`);
}

const injector = await fs.readFile(path.join(scripts, "injector.mjs"), "utf8");
assert.match(injector, /storage === undefined && themeLibrary/);
assert.match(injector, /readThemeStoragePreference\([\s\S]*inspectThemeStorage/);

console.log("PASS: every macOS verifier rebuilds the exact watcher runtime contract.");
