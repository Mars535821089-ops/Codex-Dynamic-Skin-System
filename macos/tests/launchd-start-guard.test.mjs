import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.resolve(here, "../scripts");
const commonPath = path.join(scripts, "common-macos.sh");
const startPath = path.join(scripts, "start-dream-skin-macos.sh");
const [commonSource, startSource] = await Promise.all([
  fs.readFile(commonPath, "utf8"),
  fs.readFile(startPath, "utf8"),
]);

function parserStatus(description, expectedProgram = startPath) {
  return spawnSync("/bin/bash", ["-c", `
set -euo pipefail
. "$1"
submitted_start_job_matches "$2" "$3"
`, "_", commonPath, description, expectedProgram], { encoding: "utf8" }).status;
}

test("submitted KeepAlive start jobs are recognized through direct and shell-wrapped programs", () => {
  const direct = `gui/501/io.github.codex-dynamic-skin-system.start-test = {
    path = (submitted by launchctl)
    program = ${startPath}
    arguments = {
      ${startPath}
      --port
      9341
    }
    properties = inferred program | keepalive | runatload
  }`;
  const wrapped = `gui/501/com.mars.codex-dream-skin-restart-resume-test = {
    path = (submitted by launchctl[81899])
    program = /bin/bash
    arguments = {
      /bin/bash
      -c
      "${startPath}" --port 9341 --restart-existing
    }
    properties = keepalive | inferred program
  }`;

  assert.equal(parserStatus(direct), 0);
  assert.equal(parserStatus(wrapped), 0);
  const homeRelativeStart = `$HOME${startPath.slice(process.env.HOME.length)}`;
  assert.equal(parserStatus(wrapped.replace(`\"${startPath}\"`, `\"${homeRelativeStart}\"`)), 0);
  const installedStart = "/tmp/codex-dream-skin-studio/scripts/start-dream-skin-macos.sh";
  assert.equal(
    parserStatus(wrapped.replace(`\"${startPath}\"`, installedStart), installedStart),
    0,
  );
  assert.notEqual(parserStatus(wrapped.replace(startPath, `${startPath}.backup`)), 0);
  assert.notEqual(
    parserStatus(direct.replace("(submitted by launchctl)", "/Library/LaunchAgents/job.plist")),
    0,
  );
});

test("the fuse unloads the submitted service before startup state or Codex can be touched", () => {
  assert.match(
    commonSource,
    /guard_against_submitted_keepalive_start\(\)[\s\S]*?\/bin\/launchctl bootout "gui\/\$\(\/usr\/bin\/id -u\)\/\$service"/u,
  );
  const guardCall = startSource.indexOf("guard_against_submitted_keepalive_start");
  const stateWrite = startSource.indexOf("ensure_state_root");
  assert.ok(guardCall >= 0 && stateWrite >= 0 && guardCall < stateWrite);
});
