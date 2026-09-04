import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateNativeSuiteNames } from "./native-suite-runner.mjs";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const runner = join(testsDirectory, "native-suite-runner.mjs");
const expectedSuites = [
  "config-startup-rollback.tests.ps1",
  "dynamic-v2-import.Tests.ps1",
  "start-cdp-failure-appearance-recovery.tests.ps1",
  "start-post-launch-appearance-recovery.tests.ps1",
  "start-renderer-readiness.tests.ps1",
  "start-verified-skin-preserved.tests.ps1",
  "theme-zip-import.tests.ps1",
  "zip-structure.Tests.ps1"
];
const caseVariantSuites = [
  "CONFIG-STARTUP-ROLLBACK.TESTS.PS1",
  "DYNAMIC-V2-IMPORT.tests.ps1",
  "START-CDP-FAILURE-APPEARANCE-RECOVERY.Tests.ps1",
  "START-POST-LAUNCH-APPEARANCE-RECOVERY.Tests.ps1",
  "START-RENDERER-READINESS.Tests.ps1",
  "START-VERIFIED-SKIN-PRESERVED.Tests.ps1",
  "THEME-ZIP-IMPORT.Tests.ps1",
  "ZIP-STRUCTURE.tests.ps1"
];

function createFixture({
  failingSuite = null,
  omittedSuite = null,
  extraSuite = null,
  suiteNames = expectedSuites
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dreamskin-native-suite-runner-"));
  const fixtureSuiteNames = suiteNames.filter((name) => name !== omittedSuite);
  if (extraSuite) fixtureSuiteNames.push(extraSuite);
  const suites = fixtureSuiteNames.map((name) => join(directory, name));
  for (const suite of suites) writeFileSync(suite, "# behavior fixture\n", "utf8");

  const invocationLog = join(directory, "invocations.ndjson");
  const fakeShell = join(directory, "fake-shell.mjs");
  writeFileSync(fakeShell, `
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.NATIVE_SUITE_LOG, JSON.stringify(args) + "\\n");
const fileIndex = args.indexOf("-File");
const suite = fileIndex >= 0 ? basename(args[fileIndex + 1]) : "";
if (suite === process.env.NATIVE_SUITE_FAIL) process.exit(23);
`, "utf8");
  chmodSync(fakeShell, 0o755);

  return {
    directory,
    fakeShell,
    invocationLog,
    root: join(directory, "public root"),
    suites,
    failingSuite
  };
}

function runFixture(fixture) {
  return spawnSync(process.execPath, [
    runner,
    "--shell", process.execPath,
    "--shell-prefix", fixture.fakeShell,
    "--tests-dir", fixture.directory,
    "--root", fixture.root
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      NATIVE_SUITE_LOG: fixture.invocationLog,
      NATIVE_SUITE_FAIL: fixture.failingSuite ?? ""
    }
  });
}

function readInvocations(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("native runner executes every PowerShell suite case-insensitively with the public Windows root", () => {
  const fixture = createFixture({ suiteNames: caseVariantSuites });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const invocations = readInvocations(fixture.invocationLog);
    assert.equal(invocations.length, expectedSuites.length);
    assert.deepEqual(
      invocations.map((args) => basename(args[args.indexOf("-File") + 1])).sort(),
      [...caseVariantSuites].sort()
    );
    for (const args of invocations) {
      assert.equal(args[args.indexOf("-Root") + 1], fixture.root);
      assert.ok(args.includes("-NoProfile"));
      assert.ok(args.includes("-NonInteractive"));
    }
    assert.match(result.stdout, /PASS: 8 Windows PowerShell native test suites/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("native runner returns failure after reporting a failing PowerShell suite", () => {
  const fixture = createFixture({ failingSuite: "zip-structure.Tests.ps1" });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    const invocations = readInvocations(fixture.invocationLog);
    assert.equal(invocations.length, expectedSuites.length, "all native suites should be attempted");
    assert.match(result.stderr, /zip-structure\.Tests\.ps1/);
    assert.match(result.stderr, /exit code 23/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("native runner rejects a changed native suite name set before executing anything", () => {
  const fixture = createFixture({
    omittedSuite: "dynamic-v2-import.Tests.ps1",
    extraSuite: "replacement.tests.ps1"
  });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readInvocations(fixture.invocationLog), []);
    assert.match(result.stderr, /Missing: dynamic-v2-import\.Tests\.ps1/);
    assert.match(result.stderr, /Unexpected: replacement\.tests\.ps1/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("native runner rejects case-insensitive duplicate suite names before executing anything", () => {
  const duplicateSuiteNames = [...expectedSuites, "DYNAMIC-V2-IMPORT.tests.ps1"];
  assert.throws(
    () => validateNativeSuiteNames(duplicateSuiteNames),
    /Case-insensitive duplicates: dynamic-v2-import\.tests\.ps1/
  );
});
