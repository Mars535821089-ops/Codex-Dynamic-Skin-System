import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

test("macOS release archive excludes files that are not tracked by the release repository", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-boundary-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  const checkout = join(temporaryRoot, "checkout");
  cpSync(publicRoot, checkout, {
    recursive: true,
    filter(source) {
      const relative = source.slice(publicRoot.length).replace(/^\//, "");
      return relative !== ".git" && !relative.startsWith(".git/") &&
        relative !== "macos/release" && !relative.startsWith("macos/release/");
    },
  });

  run("git", ["init", "-q"], { cwd: checkout });
  run("git", ["config", "user.name", "Release Test"], { cwd: checkout });
  run("git", ["config", "user.email", "release-test@example.invalid"], { cwd: checkout });
  run("git", ["add", "--all"], { cwd: checkout });
  run("git", ["commit", "-qm", "fixture"], { cwd: checkout });

  const sentinel = join(checkout, "macos", "PRIVATE-UNTRACKED-SENTINEL.txt");
  writeFileSync(sentinel, "must never ship\n", "utf8");
  mkdirSync(join(checkout, "macos", "release"), { recursive: true });

  run("/bin/bash", [join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests"], {
    cwd: checkout,
  });

  const version = readFileSync(join(checkout, "macos", "VERSION"), "utf8").trim();
  const archive = join(checkout, "macos", "release", `codex-dynamic-skin-system-v${version}.zip`);
  const listing = run("/usr/bin/unzip", ["-Z1", archive]);

  assert.match(listing, /codex-dynamic-skin-system\/README\.md/);
  assert.doesNotMatch(listing, /PRIVATE-UNTRACKED-SENTINEL/);
});
