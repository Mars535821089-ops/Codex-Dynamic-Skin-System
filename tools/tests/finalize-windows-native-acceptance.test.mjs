import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finalizeWindowsNativeAcceptance } from "../finalize-windows-native-acceptance.mjs";

const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const requiredChecks = [
  "imageVideoImport",
  "responsiveLayout",
  "videoLoopAndStability",
  "backgroundPlayback",
  "audioControls",
  "semanticSounds",
  "voxelAndFallback",
  "cleanupAndRestore",
];

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "windows-final-acceptance-"));
  const evidenceRoot = path.join(projectRoot, "work", "windows-native-acceptance");
  const artifactsRoot = path.join(evidenceRoot, "artifacts");
  await mkdir(artifactsRoot, { recursive: true });
  const rendererDocument = (enabled) => ({
    schema: "codex-dynamic-skin-isolated-acceptance/1",
    summary: {
      sampleCount: 50,
      stable: true,
      loopEnabled: true,
      unfocusedSamples: 50,
      pausedSamples: enabled ? 0 : 50,
      playbackAdvanced: enabled,
    },
    dynamicRuntimeSummary: {
      sampleCount: 50,
      stable: true,
      completeSamples: 50,
      connectedSamples: 50,
      invalidResourceSamples: 0,
      performance: { tiers: ["full"] },
      audio: { samples: 50, statuses: ["ready"] },
    },
    dynamicRuntimeExpectation: { requireVoxel: false, pass: true },
    playbackExpectation: { enabled, pass: true },
  });
  const rendererOn = `${JSON.stringify(rendererDocument(true), null, 2)}\n`;
  const rendererOff = `${JSON.stringify(rendererDocument(false), null, 2)}\n`;
  await writeFile(path.join(evidenceRoot, "renderer-on.json"), rendererOn);
  await writeFile(path.join(evidenceRoot, "renderer-off.json"), rendererOff);
  const nativeDefaultDocument = {
    schema: "codex-dynamic-skin-native-default-round-trip/1",
    pass: true,
    attachMode: true,
    themeId: "acceptance-theme",
    initial: { pass: true, displayMode: "theme", themeId: "acceptance-theme" },
    native: { pass: true, displayMode: "native", themeId: "acceptance-theme" },
    persistedNative: { mode: "native", themeId: "acceptance-theme" },
    nativeAfterReload: { pass: true, displayMode: "native", themeId: "acceptance-theme" },
    reapplied: { pass: true, displayMode: "theme", themeId: "acceptance-theme" },
    persistedTheme: { mode: "theme", themeId: "acceptance-theme" },
    reappliedAfterReload: { pass: true, displayMode: "theme", themeId: "acceptance-theme" },
    playbackAdvanced: true,
  };
  const nativeDefault = `${JSON.stringify(nativeDefaultDocument, null, 2)}\n`;
  await writeFile(path.join(evidenceRoot, "native-default.json"), nativeDefault);

  const automated = {
    schema: "codex-dynamic-skin-windows-native-acceptance/1",
    candidateSha,
    createdAt: "2026-08-30T00:00:00.000Z",
    host: { os: "Windows 11", architecture: "AMD64", powershell: "5.1.26100.1" },
    automated: {
      runtimeSync: "PASS",
      portableTests: "PASS",
      nativePowerShell: "PASS",
      installerStatic: "PASS",
      installerBuild: "PASS",
      installerSha256: "a".repeat(64),
      isolatedProcessFlags: "PASS",
      isolatedCleanup: "PASS",
      rendererAcceptance: { enabled: "PASS", disabled: "PASS" },
      rendererReport: { enabled: "renderer-on.json", disabled: "renderer-off.json" },
      rendererReportSha256: { enabled: digest(rendererOn), disabled: digest(rendererOff) },
      nativeDefaultRoundTrip: "PASS",
      nativeDefaultReport: "native-default.json",
      nativeDefaultReportSha256: digest(nativeDefault),
    },
    manualChecks: Object.fromEntries(requiredChecks.map((name) => [name, "PENDING"])),
    final: "FAIL",
    failure: null,
  };
  const automatedText = `${JSON.stringify(automated, null, 2)}\n`;
  const automatedPath = path.join(evidenceRoot, "automated.json");
  await writeFile(automatedPath, automatedText);

  const checks = {};
  for (const name of requiredChecks) {
    const relativePath = `artifacts/${name}.txt`;
    const contents = `verified ${name}\n`;
    await writeFile(path.join(evidenceRoot, relativePath), contents);
    checks[name] = {
      result: "PASS",
      note: `Verified ${name} on the isolated Windows profile.`,
      artifacts: [{ path: relativePath, sha256: digest(contents) }],
    };
  }
  const manual = {
    schema: "codex-dynamic-skin-windows-manual-evidence/1",
    candidateSha,
    automatedReportSha256: digest(automatedText),
    checks,
  };
  const manualPath = path.join(evidenceRoot, "manual.json");
  await writeFile(manualPath, `${JSON.stringify(manual, null, 2)}\n`);
  return { projectRoot, evidenceRoot, automatedPath, manualPath, automated, manual };
}

test("publishes an exact-SHA final PASS report from complete hashed evidence", async () => {
  const data = await fixture();
  const outputPath = path.join(data.evidenceRoot, "final.json");
  const result = await finalizeWindowsNativeAcceptance({
    projectRoot: data.projectRoot,
    automatedReportPath: data.automatedPath,
    manualEvidencePath: data.manualPath,
    outputPath,
  });

  assert.equal(result.final, "PASS");
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.automatedReport.sha256, data.manual.automatedReportSha256);
  assert.equal(result.manualEvidence.path, "work/windows-native-acceptance/manual.json");
  assert.equal(Object.keys(result.checks).length, requiredChecks.length);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).final, "PASS");
});

test("rejects missing or non-PASS manual checks", async () => {
  const data = await fixture();
  delete data.manual.checks.semanticSounds;
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /semanticSounds/,
  );
});

test("rejects an automated report whose isolated cleanup did not pass", async () => {
  const data = await fixture();
  data.automated.automated.isolatedCleanup = "FAIL";
  const automatedText = `${JSON.stringify(data.automated, null, 2)}\n`;
  await writeFile(data.automatedPath, automatedText);
  data.manual.automatedReportSha256 = digest(automatedText);
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);

  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /isolatedCleanup/,
  );
});

test("rejects a candidate mismatch and tampered artifact", async () => {
  const mismatch = await fixture();
  mismatch.manual.candidateSha = "f".repeat(40);
  await writeFile(mismatch.manualPath, `${JSON.stringify(mismatch.manual, null, 2)}\n`);
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: mismatch.projectRoot,
      automatedReportPath: mismatch.automatedPath,
      manualEvidencePath: mismatch.manualPath,
      outputPath: path.join(mismatch.evidenceRoot, "final.json"),
    }),
    /candidate SHA/i,
  );

  const tampered = await fixture();
  await writeFile(path.join(tampered.evidenceRoot, "artifacts", "audioControls.txt"), "tampered\n");
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: tampered.projectRoot,
      automatedReportPath: tampered.automatedPath,
      manualEvidencePath: tampered.manualPath,
      outputPath: path.join(tampered.evidenceRoot, "final.json"),
    }),
    /artifact hash/i,
  );
});

test("rejects hashed renderer evidence whose runtime expectation did not pass", async () => {
  const data = await fixture();
  const rendererPath = path.join(data.evidenceRoot, "renderer-on.json");
  const renderer = JSON.parse(await readFile(rendererPath, "utf8"));
  renderer.dynamicRuntimeExpectation.pass = false;
  const contents = `${JSON.stringify(renderer, null, 2)}\n`;
  await writeFile(rendererPath, contents);
  data.automated.automated.rendererReportSha256.enabled = digest(contents);
  const automatedText = `${JSON.stringify(data.automated, null, 2)}\n`;
  await writeFile(data.automatedPath, automatedText);
  data.manual.automatedReportSha256 = digest(automatedText);
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);

  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /runtime expectation/i,
  );
});

test("rejects a renderer report whose PASS flag contradicts sampled playback", async () => {
  const data = await fixture();
  const rendererPath = path.join(data.evidenceRoot, "renderer-on.json");
  const renderer = JSON.parse(await readFile(rendererPath, "utf8"));
  renderer.summary.playbackAdvanced = false;
  renderer.summary.pausedSamples = renderer.summary.sampleCount;
  const contents = `${JSON.stringify(renderer, null, 2)}\n`;
  await writeFile(rendererPath, contents);
  data.automated.automated.rendererReportSha256.enabled = digest(contents);
  const automatedText = `${JSON.stringify(data.automated, null, 2)}\n`;
  await writeFile(data.automatedPath, automatedText);
  data.manual.automatedReportSha256 = digest(automatedText);
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /enabled.*sampled playback|sampled playback.*enabled/i,
  );
});

test("rejects hashed native-default evidence whose reload round trip did not pass", async () => {
  const data = await fixture();
  const nativeDefaultPath = path.join(data.evidenceRoot, "native-default.json");
  const nativeDefault = JSON.parse(await readFile(nativeDefaultPath, "utf8"));
  nativeDefault.nativeAfterReload.pass = false;
  const contents = `${JSON.stringify(nativeDefault, null, 2)}\n`;
  await writeFile(nativeDefaultPath, contents);
  data.automated.automated.nativeDefaultReportSha256 = digest(contents);
  const automatedText = `${JSON.stringify(data.automated, null, 2)}\n`;
  await writeFile(data.automatedPath, automatedText);
  data.manual.automatedReportSha256 = digest(automatedText);
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);

  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /native.*reload|reload.*native/i,
  );
});

test("rejects paths that escape the project-owned evidence root", async () => {
  const data = await fixture();
  data.manual.checks.imageVideoImport.artifacts[0].path = "../outside.txt";
  await writeFile(data.manualPath, `${JSON.stringify(data.manual, null, 2)}\n`);
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath: path.join(data.evidenceRoot, "final.json"),
    }),
    /evidence root/i,
  );
});

test("refuses to overwrite an existing final report", async () => {
  const data = await fixture();
  const outputPath = path.join(data.evidenceRoot, "final.json");
  await writeFile(outputPath, "existing evidence\n");
  await assert.rejects(
    finalizeWindowsNativeAcceptance({
      projectRoot: data.projectRoot,
      automatedReportPath: data.automatedPath,
      manualEvidencePath: data.manualPath,
      outputPath,
    }),
    /already exists/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "existing evidence\n");
});
