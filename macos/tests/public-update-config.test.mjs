import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC_ROOT = path.resolve(HERE, "..");

async function makeEngine(t, repository) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-public-update-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const scripts = path.join(temporaryRoot, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(MAC_ROOT, "scripts/check-update-macos.sh"),
      path.join(scripts, "check-update-macos.sh")),
    fs.copyFile(path.join(MAC_ROOT, "scripts/localization-macos.sh"),
      path.join(scripts, "localization-macos.sh")),
    fs.copyFile(path.join(MAC_ROOT, "VERSION"), path.join(temporaryRoot, "VERSION")),
  ]);
  await fs.writeFile(path.join(temporaryRoot, "repository.json"),
    JSON.stringify({ githubRepository: repository }) + "\n");
  return temporaryRoot;
}

test("public update check uses configured repository and semantic version ordering", async (t) => {
  const root = await makeEngine(t, "example/codex-dynamic-skin");
  const response = path.join(root, "release.json");
  await fs.writeFile(response, JSON.stringify({ tag_name: "v9.8.7" }) + "\n");
  const result = await execFileAsync("/bin/bash", [
    path.join(root, "scripts/check-update-macos.sh"), "--json",
  ], {
    env: { ...process.env, CODEX_DREAM_SKIN_TEST_RESPONSE_FILE: response },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    currentVersion: "v1.5.17",
    latestVersion: "v9.8.7",
    updateAvailable: true,
    releaseUrl: "https://github.com/example/codex-dynamic-skin/releases/latest",
  });

  await fs.writeFile(response, JSON.stringify({ tag_name: "v1.5.15" }) + "\n");
  const older = await execFileAsync("/bin/bash", [
    path.join(root, "scripts/check-update-macos.sh"), "--json",
  ], {
    env: { ...process.env, CODEX_DREAM_SKIN_TEST_RESPONSE_FILE: response },
  });
  assert.equal(JSON.parse(older.stdout).updateAvailable, false);
});

test("public update check stays disabled before an owner configures the repository", async (t) => {
  const root = await makeEngine(t, "");
  await assert.rejects(
    execFileAsync("/bin/bash", [path.join(root, "scripts/check-update-macos.sh"), "--json"]),
    (error) => error.code === 1
      && /Update checks are disabled until githubRepository is configured/.test(error.stderr),
  );
});
