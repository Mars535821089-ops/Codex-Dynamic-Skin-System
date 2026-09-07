import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const blockedProductName = String.fromCharCode(119, 97, 105, 102, 117, 120);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function removeTemporaryRoot(temporaryRoot) {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

test("macOS release archive excludes files that are not tracked by the release repository", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-boundary-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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
  assert.match(listing, /codex-dynamic-skin-system\/INSTALL-FILES\.txt/);
  assert.doesNotMatch(listing, /PRIVATE-UNTRACKED-SENTINEL/);
});

test("macOS release build refuses a tracked public-boundary violation even when tests are skipped", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-refusal-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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
  writeFileSync(
    join(checkout, "macos", "TRACKED-PUBLIC-BOUNDARY-VIOLATION.txt"),
    `retired=${blockedProductName}\n`,
    "utf8",
  );
  run("git", ["add", "--all"], { cwd: checkout });
  run("git", ["commit", "-qm", "fixture"], { cwd: checkout });

  const result = spawnSync(
    "/bin/bash",
    [join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests"],
    { cwd: checkout, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "boundary-contaminated release unexpectedly built");
  assert.match(`${result.stdout}\n${result.stderr}`, /forbidden content/u);
});

test("macOS release build refuses a non-semantic VERSION", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-version-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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
  writeFileSync(join(checkout, "macos", "VERSION"), "release-candidate\n", "utf8");
  run("git", ["add", "--all"], { cwd: checkout });
  run("git", ["commit", "-qm", "fixture"], { cwd: checkout });

  const result = spawnSync(
    "/bin/bash",
    [join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests"],
    { cwd: checkout, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "release with a non-semantic VERSION unexpectedly built");
  assert.match(`${result.stdout}\n${result.stderr}`, /three-part semantic version/u);
  assert.equal(
    readFileSync(join(checkout, "macos", "VERSION"), "utf8"),
    "release-candidate\n",
    "the rejected VERSION was unexpectedly rewritten",
  );
});

test("macOS release build refuses a VERSION that differs from embedded runtime versions", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-version-drift-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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
  writeFileSync(join(checkout, "macos", "VERSION"), "1.5.18\n", "utf8");
  run("git", ["add", "--all"], { cwd: checkout });
  run("git", ["commit", "-qm", "fixture"], { cwd: checkout });

  const result = spawnSync(
    "/bin/bash",
    [join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests"],
    { cwd: checkout, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "release with divergent runtime versions unexpectedly built");
  assert.match(`${result.stdout}\n${result.stderr}`, /Release versions differ/u);
});

test("macOS release build refuses a stale install file manifest", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-manifest-drift-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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
  writeFileSync(join(checkout, "macos", "INSTALL-FILES.txt"), "VERSION\n", "utf8");
  run("git", ["add", "--all"], { cwd: checkout });
  run("git", ["commit", "-qm", "fixture"], { cwd: checkout });

  const result = spawnSync(
    "/bin/bash",
    [join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests"],
    { cwd: checkout, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "release with a stale install manifest unexpectedly built");
  assert.match(`${result.stdout}\n${result.stderr}`, /install file manifest/u);
});

test("macOS release archive is byte-identical when only source mtimes differ", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-skin-release-reproducible-"));
  t.after(() => removeTemporaryRoot(temporaryRoot));

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

  const build = () => run("/bin/bash", [
    join(checkout, "macos", "scripts", "build-release.sh"), "--skip-tests",
  ], { cwd: checkout });
  const version = readFileSync(join(checkout, "macos", "VERSION"), "utf8").trim();
  const archive = join(checkout, "macos", "release", `codex-dynamic-skin-system-v${version}.zip`);

  run("/usr/bin/touch", ["-t", "202001010101", join(checkout, "macos", "README.md")]);
  build();
  const first = readFileSync(archive);

  run("/usr/bin/touch", ["-t", "203001010101", join(checkout, "macos", "README.md")]);
  build();
  const second = readFileSync(archive);

  assert.deepEqual(second, first, "release bytes changed when only a tracked file mtime changed");
});
