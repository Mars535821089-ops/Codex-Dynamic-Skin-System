import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(projectRoot, "windows", "tests", "run-native-acceptance.ps1");

test("Windows native acceptance runner is candidate-bound and fail closed", async () => {
  const source = await fs.readFile(scriptPath, "utf8");

  for (const contract of [
    "[switch]$BuildInstaller",
    "[switch]$LaunchIsolated",
    "[string]$CandidateSha",
    "[string]$ProfilePath",
    "[int]$Port",
    "Assert-NoCodexProcess",
    "verify-candidate-worktree.mjs",
    "Refusing isolated launch because a Codex process is already running",
    "-ProfilePath",
    "-Port",
    "manualChecks",
    "PENDING",
    "ConvertTo-Json",
    "Move-Item",
    "isolated-codex-acceptance.mjs",
    "rendererAcceptance",
    "nativeDefaultRoundTrip",
    "native-default-acceptance.mjs",
    "isolatedCleanup",
    "AcceptanceThemeDirectory",
  ]) {
    assert.ok(source.includes(contract), `missing Windows acceptance contract: ${contract}`);
  }

  assert.equal(source.includes("-RestartExisting"), false);
  assert.equal(source.includes("--untracked-files=no"), false);
  assert.match(source, /git[\s\S]*rev-parse[\s\S]*HEAD/);
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /powershell\.exe[\s\S]*run-tests\.ps1/);
  assert.match(source, /installer-static\.tests\.ps1/);
  assert.match(source, /--attach-port[\s\S]*--expected-pid[\s\S]*--profile/);
  assert.match(source, /ValidateSet\(['"]on['"], ['"]off['"]\)/);
  assert.match(source, /BackgroundPlayback ['"]on['"][\s\S]*BackgroundPlayback ['"]off['"]/);
  assert.match(source, /native-default-acceptance\.mjs[\s\S]*--attach-port[\s\S]*--expected-pid[\s\S]*--profile[\s\S]*--selection-file/);
  assert.match(source, /nativeDefaultRoundTrip[\s\S]*reportPath[\s\S]*reportSha256/);
  assert.match(source, /rendererOn\.reportPath\.Substring\(\$workRoot\.Length\)/);
  assert.match(source, /nativeDefault\.reportPath\.Substring\(\$workRoot\.Length\)/);
  assert.match(source, /summary\.loopEnabled/);
  assert.match(source, /pausedSamples[\s\S]*sampleCount/);
  assert.match(source, /dynamicRuntimeExpectation\.pass/);
  assert.match(source, /dynamicRuntimeSummary\.completeSamples/);
  assert.match(source, /dynamicRuntimeSummary\.connectedSamples/);
  assert.match(source, /dynamicRuntimeSummary\.audio\.samples/);
  assert.match(source, /Test-AcceptancePathWithin/);
  assert.match(source, /Invoke-WithAcceptanceEnvironment/);
  assert.match(source, /sandbox-["']?\s*\+\s*\$CandidateSha/);
  assert.match(source, /profiles/);
  assert.match(source, /restore-dream-skin\.ps1[\s\S]*-ForceRestart[\s\S]*-NoRelaunch/);
  assert.match(source, /Get-IsolatedProfileProcesses/);
  assert.match(source, /Remove-AcceptanceSandbox/);
  assert.match(source, /cleanupMessages/);
  assert.match(source, /ownedProcessesStopped/);
  assert.match(source, /acceptance-inputs/);
  assert.match(source, /Set-DreamSkinActiveTheme/);
  assert.match(source, /AcceptanceThemeDirectory[\s\S]*project-owned acceptance input root/);
  assert.match(source, /OutputPath[\s\S]*Test-AcceptancePathWithin[\s\S]*project-owned Windows acceptance work root/);
});

test("Windows injector accepts the isolated runner background capability contract", async () => {
  const source = await fs.readFile(path.join(projectRoot, "windows", "scripts", "injector.mjs"), "utf8");
  assert.match(source, /backgroundPlaybackCapable:\s*false/);
  assert.match(source, /--background-playback-capable["']\)\s*options\.backgroundPlaybackCapable\s*=\s*true/);
  assert.match(source, /backgroundPlaybackSupport/);
});

test("Windows launcher enables real background media playback at process start", async () => {
  const source = await fs.readFile(path.join(projectRoot, "windows", "scripts", "start-dream-skin.ps1"), "utf8");
  for (const flag of [
    "--disable-background-media-suspend",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--background-playback-capable",
  ]) {
    assert.ok(source.includes(flag), `missing Windows background playback launch contract: ${flag}`);
  }
});
