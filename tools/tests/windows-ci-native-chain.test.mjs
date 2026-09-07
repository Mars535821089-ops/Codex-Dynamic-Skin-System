import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWindowsNativeCiChain } from "../verify-windows-native-ci.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const validWorkflow = `
jobs:
  windows-tests:
    strategy:
      matrix:
        shell: [powershell.exe, pwsh.exe]
    runs-on: windows-latest
    steps:
      - name: Run Windows and portable regressions
        shell: cmd
        run: \${{ matrix.shell }} -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File .\\windows\\tests\\run-tests.ps1
`;

const validRunner = `
$tests = Get-ChildItem -LiteralPath (Join-Path $root 'windows/tests') -Filter '*.test.mjs' -File
& node --test @($tests.FullName)
if ($LASTEXITCODE -ne 0) { throw "Windows JavaScript tests failed" }
& node (Join-Path $root 'windows/tests/native-suite-runner.mjs') \\
  '--shell' $powerShellPath \\
  '--tests-dir' (Join-Path $root 'windows/tests') \\
  '--root' (Join-Path $root 'windows')
if ($LASTEXITCODE -ne 0) { throw "native tests failed" }
`;

function createFixture({ workflow = validWorkflow, runner = validRunner } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dreamskin-windows-ci-chain-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "windows", "tests"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow, "utf8");
  writeFileSync(join(root, "windows", "tests", "run-tests.ps1"), runner, "utf8");
  return root;
}

test("Windows CI reaches the native suite runner through both supported PowerShell hosts", () => {
  assert.deepEqual(verifyWindowsNativeCiChain(projectRoot), {
    shells: ["powershell.exe", "pwsh.exe"],
    entrypoint: "windows/tests/run-tests.ps1",
    nativeRunner: "windows/tests/native-suite-runner.mjs"
  });
});

test("Windows CI contract rejects dropping the PowerShell 7 host", () => {
  const root = createFixture({
    workflow: validWorkflow.replace("[powershell.exe, pwsh.exe]", "[powershell.exe]")
  });
  try {
    assert.throws(() => verifyWindowsNativeCiChain(root), /powershell\.exe and pwsh\.exe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows CI contract rejects bypassing the public Windows test entrypoint", () => {
  const root = createFixture({
    workflow: validWorkflow.replace("run-tests.ps1", "portable-only.ps1")
  });
  try {
    assert.throws(() => verifyWindowsNativeCiChain(root), /windows\/tests\/run-tests\.ps1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows CI contract rejects an entrypoint that no longer runs native suites", () => {
  const root = createFixture({ runner: "& node --test $tests\n" });
  try {
    assert.throws(() => verifyWindowsNativeCiChain(root), /native-suite-runner\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows CI contract rejects platform-foreign macOS test discovery", () => {
  const root = createFixture({
    runner: validRunner.replace("windows/tests') -Filter", "macos/tests') -Filter")
  });
  try {
    assert.throws(() => verifyWindowsNativeCiChain(root), /Windows JavaScript tests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
