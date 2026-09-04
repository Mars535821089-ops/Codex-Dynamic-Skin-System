import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifierPath = path.join(projectRoot, "tools", "verify-candidate-worktree.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeCandidateRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-candidate-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Dream Skin Test");
  git(root, "config", "user.email", "dream-skin-test@example.invalid");
  await fs.writeFile(path.join(root, "tracked.txt"), "candidate\n", "utf8");
  git(root, "add", "tracked.txt");
  git(root, "commit", "--quiet", "-m", "candidate");
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

function verify(cwd, sha) {
  return spawnSync(process.execPath, [verifierPath, sha], {
    cwd,
    encoding: "utf8",
  });
}

test("candidate verifier rejects untracked source that is absent from the bound commit", async (t) => {
  const candidate = await makeCandidateRepository();
  t.after(() => fs.rm(candidate.root, { recursive: true, force: true }));

  const clean = verify(candidate.root, candidate.sha);
  assert.equal(clean.status, 0, clean.stderr);

  const privateName = "uncommitted-private-theme.mjs";
  await fs.writeFile(path.join(candidate.root, privateName), "export {};\n", "utf8");
  const dirty = verify(candidate.root, candidate.sha);

  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /candidate worktree is dirty/i);
  assert.doesNotMatch(dirty.stderr, new RegExp(privateName));
});

test("default Windows acceptance artifacts do not dirty the committed candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Dream Skin Test");
  git(root, "config", "user.email", "dream-skin-test@example.invalid");
  await fs.copyFile(path.join(projectRoot, ".gitignore"), path.join(root, ".gitignore"));
  await fs.writeFile(path.join(root, "tracked.txt"), "candidate\n", "utf8");
  git(root, "add", ".gitignore", "tracked.txt");
  git(root, "commit", "--quiet", "-m", "candidate");
  const sha = git(root, "rev-parse", "HEAD");

  const evidenceRoot = path.join(root, "work", "windows-native-acceptance");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, `acceptance-${sha}.json`), "{}\n", "utf8");

  const result = verify(root, sha);
  assert.equal(result.status, 0, result.stderr);
});

test("local planning artifacts do not prevent candidate handoff", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-planning-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Dream Skin Test");
  git(root, "config", "user.email", "dream-skin-test@example.invalid");
  await fs.copyFile(path.join(projectRoot, ".gitignore"), path.join(root, ".gitignore"));
  await fs.writeFile(path.join(root, "tracked.txt"), "candidate\n", "utf8");
  git(root, "add", ".gitignore", "tracked.txt");
  git(root, "commit", "--quiet", "-m", "candidate");
  const sha = git(root, "rev-parse", "HEAD");

  const planningRoot = path.join(root, ".planning");
  await fs.mkdir(planningRoot, { recursive: true });
  await fs.writeFile(path.join(planningRoot, "local-note.md"), "local only\n", "utf8");

  const result = verify(root, sha);
  assert.equal(result.status, 0, result.stderr);
});
