import { createHash, randomBytes } from "node:crypto";
import { access, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const moduleProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const automatedSchema = "codex-dynamic-skin-windows-native-acceptance/1";
const manualSchema = "codex-dynamic-skin-windows-manual-evidence/1";
const finalSchema = "codex-dynamic-skin-windows-final-acceptance/1";
const shaPattern = /^[0-9a-f]{64}$/;
const candidatePattern = /^[0-9a-f]{40}$/;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function portableRelative(projectRoot, target) {
  return path.relative(projectRoot, target).split(path.sep).join("/");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readJson(target, label) {
  const text = await readFile(target, "utf8");
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function assertRegularFileInside(root, target, label) {
  const rootReal = await realpath(root);
  const stat = await lstat(target);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file.`);
  const targetReal = await realpath(target);
  assert(isInside(rootReal, targetReal), `${label} escaped the project-owned evidence root.`);
  return targetReal;
}

function validateAutomated(automated) {
  assert(automated?.schema === automatedSchema, "Automated report schema is not supported.");
  assert(candidatePattern.test(automated?.candidateSha ?? ""), "Automated candidate SHA is invalid.");
  const gates = automated?.automated ?? {};
  for (const name of [
    "runtimeSync",
    "portableTests",
    "nativePowerShell",
    "installerStatic",
    "installerBuild",
    "isolatedProcessFlags",
    "isolatedCleanup",
  ]) {
    assert(gates[name] === "PASS", `Automated gate ${name} is not PASS.`);
  }
  assert(shaPattern.test(gates.installerSha256 ?? ""), "Installer SHA-256 is missing or invalid.");
  assert(gates.rendererAcceptance?.enabled === "PASS", "Enabled renderer acceptance is not PASS.");
  assert(gates.rendererAcceptance?.disabled === "PASS", "Disabled renderer acceptance is not PASS.");
  for (const mode of ["enabled", "disabled"]) {
    assert(typeof gates.rendererReport?.[mode] === "string" && gates.rendererReport[mode], `Renderer ${mode} report path is missing.`);
    assert(shaPattern.test(gates.rendererReportSha256?.[mode] ?? ""), `Renderer ${mode} report SHA-256 is invalid.`);
  }
  assert(gates.nativeDefaultRoundTrip === "PASS", "Native-default round-trip acceptance is not PASS.");
  assert(typeof gates.nativeDefaultReport === "string" && gates.nativeDefaultReport,
    "Native-default round-trip report path is missing.");
  assert(shaPattern.test(gates.nativeDefaultReportSha256 ?? ""),
    "Native-default round-trip report SHA-256 is invalid.");
  assert(automated.failure == null, "Automated report contains a failure.");
  assert(automated.final === "FAIL", "Automated report must remain an unmodified pre-finalization report.");
}

function validateManual(manual, automatedSha, candidateSha) {
  assert(manual?.schema === manualSchema, "Manual evidence schema is not supported.");
  assert(manual?.candidateSha === candidateSha, "Manual evidence candidate SHA does not match the automated report.");
  assert(manual?.automatedReportSha256 === automatedSha, "Manual evidence is not bound to the exact automated report hash.");
  for (const name of requiredChecks) {
    const check = manual?.checks?.[name];
    assert(check, `Manual check ${name} is missing.`);
    assert(check.result === "PASS", `Manual check ${name} is not PASS.`);
    assert(typeof check.note === "string" && check.note.trim().length > 0 && check.note.length <= 1000,
      `Manual check ${name} must include a non-empty note of at most 1000 characters.`);
    assert(Array.isArray(check.artifacts) && check.artifacts.length > 0,
      `Manual check ${name} must include at least one artifact.`);
  }
}

async function validateBoundArtifact(evidenceRoot, artifact, label) {
  assert(typeof artifact?.path === "string" && artifact.path.length > 0, `${label} path is missing.`);
  assert(!path.isAbsolute(artifact.path), `${label} escaped the project-owned evidence root.`);
  const normalized = path.normalize(artifact.path);
  assert(normalized !== ".." && !normalized.startsWith(`..${path.sep}`), `${label} escaped the project-owned evidence root.`);
  assert(shaPattern.test(artifact.sha256 ?? ""), `${label} SHA-256 is invalid.`);
  const target = path.resolve(evidenceRoot, normalized);
  await assertRegularFileInside(evidenceRoot, target, label);
  const contents = await readFile(target);
  assert(sha256(contents) === artifact.sha256, `${label} artifact hash does not match.`);
  return { path: normalized.split(path.sep).join("/"), sha256: artifact.sha256 };
}

async function validateRendererArtifact(evidenceRoot, artifact, mode) {
  const label = `Renderer ${mode} report`;
  const verified = await validateBoundArtifact(evidenceRoot, artifact, label);
  const target = path.resolve(evidenceRoot, verified.path);
  const document = (await readJson(target, label)).value;
  assert(document?.schema === "codex-dynamic-skin-isolated-acceptance/1",
    `${label} schema is not supported.`);
  assert(document?.summary?.stable === true && document?.summary?.loopEnabled === true,
    `${label} did not prove stable looping playback.`);
  assert(document?.summary?.sampleCount > 1
    && document.summary.unfocusedSamples === document.summary.sampleCount,
  `${label} did not prove fully unfocused sampling.`);
  assert(document?.dynamicRuntimeExpectation?.pass === true,
    `${label} runtime expectation is not PASS.`);
  assert(document?.dynamicRuntimeSummary?.completeSamples === document.dynamicRuntimeSummary.sampleCount
    && document.dynamicRuntimeSummary.connectedSamples === document.dynamicRuntimeSummary.sampleCount
    && document.dynamicRuntimeSummary.invalidResourceSamples === 0
    && document.dynamicRuntimeSummary.audio?.samples === document.dynamicRuntimeSummary.sampleCount,
  `${label} runtime diagnostics are incomplete or invalid.`);
  const enabled = mode === "enabled";
  assert(document?.playbackExpectation?.enabled === enabled
    && document.playbackExpectation.pass === true,
  `${label} background playback expectation is not PASS.`);
  if (enabled) {
    assert(document.summary.playbackAdvanced === true && document.summary.pausedSamples === 0,
      `${label} sampled playback contradicts enabled background playback.`);
  } else {
    assert(document.summary.playbackAdvanced === false
      && document.summary.pausedSamples === document.summary.sampleCount,
    `${label} sampled playback contradicts disabled background playback.`);
  }
  return verified;
}

async function validateNativeDefaultArtifact(evidenceRoot, artifact) {
  const label = "Native-default round-trip report";
  const verified = await validateBoundArtifact(evidenceRoot, artifact, label);
  const document = (await readJson(path.resolve(evidenceRoot, verified.path), label)).value;
  assert(document?.schema === "codex-dynamic-skin-native-default-round-trip/1",
    `${label} schema is not supported.`);
  assert(document?.pass === true && document?.attachMode === true,
    `${label} did not prove a PASS attached-instance lifecycle.`);
  assert(typeof document?.themeId === "string" && document.themeId.length > 0,
    `${label} theme identity is missing.`);
  assert(document?.initial?.pass === true && document.initial.displayMode === "theme"
    && document.initial.themeId === document.themeId,
  `${label} did not prove the initial theme state.`);
  assert(document?.native?.pass === true && document.native.displayMode === "native"
    && document.native.themeId === document.themeId,
    `${label} did not prove native mode.`);
  assert(document?.persistedNative?.mode === "native"
    && document.persistedNative.themeId === document.themeId,
    `${label} did not prove persisted native mode.`);
  assert(document?.nativeAfterReload?.pass === true
    && document.nativeAfterReload.displayMode === "native"
    && document.nativeAfterReload.themeId === document.themeId,
    `${label} did not prove native mode after reload.`);
  assert(document?.reapplied?.pass === true && document.reapplied.displayMode === "theme"
    && document.reapplied.themeId === document.themeId,
  `${label} did not prove theme reapplication.`);
  assert(document?.persistedTheme?.mode === "theme"
    && document.persistedTheme.themeId === document.themeId,
  `${label} did not prove the persisted reapplied theme.`);
  assert(document?.reappliedAfterReload?.pass === true
    && document.reappliedAfterReload.displayMode === "theme"
    && document.reappliedAfterReload.themeId === document.themeId,
  `${label} did not prove the reapplied theme after reload.`);
  assert(document?.playbackAdvanced === true,
    `${label} did not prove advancing video after the complete reload round trip.`);
  return verified;
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function finalizeWindowsNativeAcceptance({
  projectRoot = moduleProjectRoot,
  automatedReportPath,
  manualEvidencePath,
  outputPath,
}) {
  const root = path.resolve(projectRoot);
  const evidenceRoot = path.join(root, "work", "windows-native-acceptance");
  await mkdir(evidenceRoot, { recursive: true });
  const automatedPath = path.resolve(automatedReportPath);
  const manualPath = path.resolve(manualEvidencePath);
  const finalPath = path.resolve(outputPath);
  await assertRegularFileInside(evidenceRoot, automatedPath, "Automated report");
  await assertRegularFileInside(evidenceRoot, manualPath, "Manual evidence");
  assert(isInside(evidenceRoot, finalPath), "Final report escaped the project-owned evidence root.");
  assert(!(await fileExists(finalPath)), "Final report already exists; refusing to overwrite it.");

  const automatedDocument = await readJson(automatedPath, "Automated report");
  const manualDocument = await readJson(manualPath, "Manual evidence");
  validateAutomated(automatedDocument.value);
  const automatedSha = sha256(automatedDocument.text);
  validateManual(manualDocument.value, automatedSha, automatedDocument.value.candidateSha);

  const rendererReports = {};
  for (const mode of ["enabled", "disabled"]) {
    rendererReports[mode] = await validateRendererArtifact(evidenceRoot, {
      path: automatedDocument.value.automated.rendererReport[mode],
      sha256: automatedDocument.value.automated.rendererReportSha256[mode],
    }, mode);
  }
  const nativeDefaultReport = await validateNativeDefaultArtifact(evidenceRoot, {
    path: automatedDocument.value.automated.nativeDefaultReport,
    sha256: automatedDocument.value.automated.nativeDefaultReportSha256,
  });

  const checks = {};
  for (const name of requiredChecks) {
    const source = manualDocument.value.checks[name];
    checks[name] = {
      result: "PASS",
      note: source.note.trim(),
      artifacts: await Promise.all(source.artifacts.map((artifact, index) =>
        validateBoundArtifact(evidenceRoot, artifact, `Manual check ${name} artifact ${index + 1}`))),
    };
  }

  const finalReport = {
    schema: finalSchema,
    candidateSha: automatedDocument.value.candidateSha,
    createdAt: new Date().toISOString(),
    host: automatedDocument.value.host,
    automatedReport: {
      path: portableRelative(root, automatedPath),
      sha256: automatedSha,
      gates: automatedDocument.value.automated,
      verifiedRendererReports: rendererReports,
      verifiedNativeDefaultReport: nativeDefaultReport,
    },
    manualEvidence: {
      path: portableRelative(root, manualPath),
      sha256: sha256(manualDocument.text),
    },
    checks,
    final: "PASS",
  };

  const temporary = path.join(evidenceRoot, `.final-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(finalReport, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await link(temporary, finalPath);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return finalReport;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--automated-report", "--manual-evidence", "--output"].includes(argument)) {
      assert(value, `${argument} requires a path.`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assert(options.automatedReport && options.manualEvidence, "--automated-report and --manual-evidence are required.");
  const candidate = JSON.parse(await readFile(path.resolve(moduleProjectRoot, options.automatedReport), "utf8")).candidateSha;
  assert(candidatePattern.test(candidate ?? ""), "Automated candidate SHA is invalid.");
  const verification = spawnSync(process.execPath, [
    path.join(moduleProjectRoot, "tools", "verify-candidate-worktree.mjs"),
    candidate,
  ], { cwd: moduleProjectRoot, encoding: "utf8", stdio: "inherit" });
  assert(!verification.error && verification.status === 0, "Candidate worktree verification failed.");
  const result = await finalizeWindowsNativeAcceptance({
    projectRoot: moduleProjectRoot,
    automatedReportPath: path.resolve(moduleProjectRoot, options.automatedReport),
    manualEvidencePath: path.resolve(moduleProjectRoot, options.manualEvidence),
    outputPath: path.resolve(moduleProjectRoot, options.output ?? `work/windows-native-acceptance/final-${candidate}.json`),
  });
  console.log(`Windows native acceptance finalized: ${result.candidateSha}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
