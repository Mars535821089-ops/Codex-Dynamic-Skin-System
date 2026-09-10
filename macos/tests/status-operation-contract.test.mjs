import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = await fs.readFile(new URL("../scripts/status-dream-skin-macos.sh", import.meta.url), "utf8");
const reader = source.slice(source.indexOf("read_plist_snapshot_field() {"), source.indexOf("# Keep this check"));
const operation = source.slice(source.indexOf('if [ -f "$OPERATION_STATE_PATH" ]; then'),
  source.indexOf('if [ "$SESSION" = "applying" ]'));
assert.ok(reader.startsWith("read_plist_snapshot_field() {"));
assert.equal(operation.split("/bin/date +%s").length, 2);
const frozenOperation = operation.replace("/bin/date +%s", "printf '%s' 2000000000");
const formatter = source.slice(source.indexOf('if [ "$JSON" = "true" ]; then'),
  source.indexOf("printf 'session=%s"));
assert.ok(formatter.startsWith('if [ "$JSON" = "true" ]; then'));

// This is the real status reader used by the monitor. An expired operation
// must release the repair gate; a live operation must hold it even before
// the startup script has published a watcher/session state file.
for (const [status, age, expected] of [
  ["applying", 0, "applying"], ["applying", 180, "applying"],
  ["applying", 181, "failed"], ["applying", 301, ""],
  ["pausing", 90, "pausing"], ["pausing", 91, "failed"],
  ["pausing", 211, ""], ["applying", -1, ""],
  ["success", 0, "success"], ["success", 13, ""],
  ["unknown", 0, ""],
]) {
  test(`status releases or retains ${status} operation at age ${age} seconds`,
    { skip: process.platform !== "darwin" }, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cdss-operation-ttl-"));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const operationPath = path.join(root, "operation-state.plist");
      const jsonPath = path.join(root, "operation.json");
      await fs.writeFile(jsonPath, JSON.stringify({ status, message: "fixture", updatedAt: 2000000000 - age }));
      const plist = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", operationPath, jsonPath], { encoding: "utf8" });
      assert.equal(plist.status, 0, plist.stderr);
      const result = spawnSync("/bin/bash", ["-c", `
set -eu
OPERATION_STATE_PATH="$1"
OPERATION_STATUS=''
OPERATION_MESSAGE=''
JSON=true
SESSION=unknown
PORT=9341
CODEX_PID=0
INJECTOR_ALIVE=false
CDP_OK=false
CODEX_RUNNING=false
THEME_ID=''
THEME_NAME=''
APPLIED_THEME_ID=''
APPLIED_THEME_NAME=''
dreamskin_text() { printf 'Operation timed out'; }
${reader}
${frozenOperation}
${formatter}
`, "status-operation-fixture", operationPath], { encoding: "utf8", timeout: 5000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const snapshot = JSON.parse(result.stdout);
      assert.equal(typeof snapshot.operation, "string");
      assert.equal(snapshot.operation, expected);
      assert.deepEqual((await fs.readdir(root)).sort(), ["operation-state.plist", "operation.json"]);
    });
}
