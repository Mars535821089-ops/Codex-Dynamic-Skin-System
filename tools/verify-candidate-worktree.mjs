import { spawnSync } from "node:child_process";

const candidateSha = process.argv[2];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail("Could not inspect the candidate worktree.");
  }
  return result.stdout.trim();
}

if (!/^[0-9a-f]{40}$/.test(candidateSha ?? "")) {
  fail("Candidate SHA must be a lowercase 40-character Git SHA.");
}

const headSha = runGit(["rev-parse", "HEAD"]);
if (headSha !== candidateSha) {
  fail("Candidate SHA does not match the checked-out HEAD.");
}

const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status !== "") {
  fail("The candidate worktree is dirty; native evidence must bind to a committed candidate.");
}

console.log(`Candidate worktree is clean and bound to ${candidateSha}.`);
