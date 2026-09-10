import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const commonPath = path.join(scripts, "common-macos.sh");
const [commonSource, startSource] = await Promise.all([
  fs.readFile(commonPath, "utf8"),
  fs.readFile(path.join(scripts, "start-dream-skin-macos.sh"), "utf8"),
]);
const startExitHandler = startSource.slice(
  startSource.indexOf("record_start_exit() {"),
  startSource.indexOf("\nPORT=9341"),
);
const startCompletion = startSource.slice(startSource.lastIndexOf("mark_state_active ||"));
const originalWriter = commonSource.slice(
  commonSource.indexOf("write_operation_state() {"),
  commonSource.indexOf("clear_operation_state() {"),
).replace("write_operation_state() {", "original_write_operation_state() {");

async function runFixture(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-completion-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "theme"));
  await fs.writeFile(path.join(root, "theme/theme.json"), JSON.stringify({
    id: "test.operation-completion", name: "Completion fixture",
  }));
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify({
    session: "applying", port: 9341, injectorPid: 0,
  }));
  const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
. "$1"
STATE_ROOT="$2"
STATE_PATH="$STATE_ROOT/state.json"
OPERATION_STATE_PATH="$STATE_ROOT/operation-state.plist"
START_ERROR_LOG="$STATE_ROOT/start-error.log"
THEME_DIR="$STATE_ROOT/theme"
NODE="$3"
PORT=9341
OPERATION_TOKEN='123:1789044954000:1'
NEW_TOKEN='456:1789044955000:1'
OPERATION_FINISHED=false
VERIFY_OUTPUT=''
ensure_node_runtime() { return 0; }
finish_client_operation() { printf '%s|%s|%s\\n' "$2" "$4" "$3" >> "$STATE_ROOT/client.log"; }
${originalWriter}
write_operation_state applying 'Applying old operation' "$OPERATION_TOKEN"
${body}
`, "operation-completion-fixture", commonPath, root, process.execPath], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
  const operation = spawnSync("/usr/bin/plutil", [
    "-convert", "json", "-o", "-", path.join(root, "operation-state.plist"),
  ], { encoding: "utf8" });
  const client = await fs.readFile(path.join(root, "client.log"), "utf8")
    .catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  return {
    ...result, state, client,
    operation: operation.status === 0 ? JSON.parse(operation.stdout) : null,
  };
}

test("a superseded terminal publication preserves the newer operation and returns 2", async (t) => {
  const result = await runFixture(t, `
write_operation_state applying 'Applying newer operation' "$NEW_TOKEN"
result=0
write_operation_state success 'Old success' "$OPERATION_TOKEN" || result=$?
printf 'publication=%s\\n' "$result"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "publication=2\n");
  assert.equal(result.operation.operationToken, "456:1789044955000:1");
  assert.equal(result.operation.status, "applying");
});

test("startup completion is silent when its operation has been superseded", async (t) => {
  const result = await runFixture(t, `
write_operation_state applying 'Applying newer operation' "$NEW_TOKEN"
${startExitHandler}
${startCompletion}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.client, "");
  assert.equal(result.stdout, "");
  assert.equal(result.operation.operationToken, "456:1789044955000:1");
  assert.equal(result.operation.status, "applying");
});

test("startup completion still publishes success for the current operation", async (t) => {
  const result = await runFixture(t, `${startExitHandler}\n${startCompletion}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.session, "active");
  assert.equal(result.operation.status, "success");
  assert.equal(result.operation.operationToken, "123:1789044954000:1");
  assert.equal(result.client, "");
});

test("a real completion write failure remains a startup error", async (t) => {
  const result = await runFixture(t, `
/bin/mkdir "$OPERATION_STATE_PATH.$$.tmp"
${startExitHandler}
${startCompletion}
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not publish the completed apply state/);
  assert.equal(result.state.session, "active");
  assert.match(result.client, /^error\|123:1789044954000:1\|/);
});

test("an old startup failure cannot stale or notify a newer applying operation", async (t) => {
  const result = await runFixture(t, `
write_operation_state applying 'Applying newer operation' "$NEW_TOKEN"
${startExitHandler}
exit 7
`);
  assert.equal(result.status, 7);
  assert.equal(result.state.session, "applying");
  assert.equal(result.operation.operationToken, "456:1789044955000:1");
  assert.equal(result.operation.status, "applying");
  assert.equal(result.client, "");
});

test("supersession while publishing failure cancels the old session and client mutations", async (t) => {
  const result = await runFixture(t, `
write_operation_state() {
  if [ "$1" = failed ]; then
    original_write_operation_state applying 'Applying newer operation' "$NEW_TOKEN"
  fi
  original_write_operation_state "$@"
}
${startExitHandler}
exit 7
`);
  assert.equal(result.status, 7);
  assert.equal(result.state.session, "applying");
  assert.equal(result.operation.operationToken, "456:1789044955000:1");
  assert.equal(result.operation.status, "applying");
  assert.equal(result.client, "");
});

test("the current startup failure still marks its session stale and notifies the client", async (t) => {
  const result = await runFixture(t, `${startExitHandler}\nexit 7`);
  assert.equal(result.status, 7);
  assert.equal(result.state.session, "stale");
  assert.equal(result.operation.status, "failed");
  assert.match(result.client, /^error\|123:1789044954000:1\|/);
});

test("unreadable operation ownership preserves the session while retaining the startup error", async (t) => {
  const result = await runFixture(t, `
/usr/bin/printf 'invalid plist\\n' > "$OPERATION_STATE_PATH"
${startExitHandler}
exit 7
`);
  assert.equal(result.status, 7);
  assert.equal(result.state.session, "applying");
  assert.equal(result.operation, null);
  assert.equal(result.client, "");
  assert.match(result.stderr, /start failed/);
});

const hotApplyDependencies = `
verified_cdp_endpoint() { return 0; }
stop_recorded_injector() { return 0; }
launch_injector_daemon() { printf '%s\\n' "$$"; }
process_started_at() { printf 'fixture-start\\n'; }
codex_main_pids() { printf '0\\n'; }
resolve_current_theme_dir() { printf '%s\\n' "$THEME_DIR"; }
`;

test("hot apply completion supersession does not select the full-start fallback", async (t) => {
  const result = await runFixture(t, `
${hotApplyDependencies}
run_injector_verify() { write_operation_state applying 'Applying newer operation' "$NEW_TOKEN"; }
if hot_reapply_theme "$PORT" 8000 "$OPERATION_TOKEN"; then
  printf 'handled\\n'
else
  printf 'full-start\\n'
fi
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "handled\n");
  assert.equal(result.operation.operationToken, "456:1789044955000:1");
  assert.equal(result.operation.status, "applying");
});

test("hot apply does not swallow a real completion write failure", async (t) => {
  const result = await runFixture(t, `
${hotApplyDependencies}
run_injector_verify() { /bin/mkdir "$OPERATION_STATE_PATH.$$.tmp"; }
result=0
hot_reapply_theme "$PORT" 8000 "$OPERATION_TOKEN" || result=$?
printf 'hot-apply=%s\\n' "$result"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "hot-apply=1\n");
});
