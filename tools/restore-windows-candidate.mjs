import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MANIFEST_SCHEMA = "codex-dynamic-skin-windows-candidate/2";
const MANIFEST_KEYS = [
  "bundleFile",
  "bundleSha256",
  "candidateSha",
  "receiverFile",
  "receiverSha256",
  "restore",
  "schema",
];
const receiverPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { manifestPath: null, targetPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      const value = argv[++index];
      if (!value) fail("--manifest requires a JSON manifest path.");
      options.manifestPath = path.resolve(value);
    } else if (argument === "--target") {
      const value = argv[++index];
      if (!value) fail("--target requires a new checkout directory.");
      options.targetPath = path.resolve(value);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!options.manifestPath || !options.targetPath) {
    fail("Usage: node restore-windows-candidate.mjs --manifest <manifest.json> --target <new-directory>");
  }
  return options;
}

async function assertRegularFile(target, label) {
  let info;
  try {
    info = await lstat(target);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail(`${label} must be a regular non-symlink file.`);
  }
}

async function assertTargetAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("Could not inspect the target checkout path.");
  }
  fail("Target checkout already exists; refusing to replace it.");
}

async function assertSafeParent(target) {
  const parent = path.dirname(target);
  let info;
  try {
    info = await lstat(parent);
  } catch {
    fail("Target parent directory does not exist.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("Target parent must be a regular non-symlink directory.");
  }
  return parent;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Candidate manifest must be a JSON object.");
  }
  const keys = Object.keys(manifest).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
    fail("Candidate manifest fields do not match the supported schema.");
  }
  if (manifest.schema !== MANIFEST_SCHEMA) fail("Candidate manifest schema is unsupported.");
  if (!/^[0-9a-f]{40}$/.test(manifest.candidateSha)) {
    fail("Candidate manifest SHA must be a lowercase 40-character Git SHA.");
  }
  const expectedBundle = `CodexDynamicSkinSystem-windows-candidate-${manifest.candidateSha.slice(0, 12)}.bundle`;
  if (manifest.bundleFile !== expectedBundle || path.basename(manifest.bundleFile) !== manifest.bundleFile) {
    fail("Candidate manifest bundle filename is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.bundleSha256)) {
    fail("Candidate manifest bundle SHA-256 is invalid.");
  }
  const expectedReceiver = `CodexDynamicSkinSystem-windows-candidate-${manifest.candidateSha.slice(0, 12)}-restore.mjs`;
  if (manifest.receiverFile !== expectedReceiver || path.basename(manifest.receiverFile) !== manifest.receiverFile) {
    fail("Candidate manifest receiver filename is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.receiverSha256)) {
    fail("Candidate manifest receiver SHA-256 is invalid.");
  }
  const expectedRestore = [
    `git clone ${manifest.bundleFile} Codex-Dynamic-Skin-System`,
    `git -C Codex-Dynamic-Skin-System checkout --detach ${manifest.candidateSha}`,
    `node Codex-Dynamic-Skin-System/tools/verify-candidate-worktree.mjs ${manifest.candidateSha}`,
  ];
  if (!Array.isArray(manifest.restore)
      || manifest.restore.length !== expectedRestore.length
      || manifest.restore.some((command, index) => command !== expectedRestore[index])) {
    fail("Candidate manifest restore contract is invalid.");
  }
  return manifest;
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(detail ? `Candidate restore command failed: ${detail}` : "Candidate restore command failed.");
  }
  return result.stdout.trim();
}

async function main() {
  const { manifestPath, targetPath } = parseArguments(process.argv.slice(2));
  await assertTargetAbsent(targetPath);
  const targetParent = await assertSafeParent(targetPath);
  await assertRegularFile(manifestPath, "Candidate manifest");

  let manifest;
  try {
    const bytes = await readFile(manifestPath);
    if (bytes.length > 64 * 1024) fail("Candidate manifest exceeds the size limit.");
    manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail("Candidate manifest is not valid JSON.");
    throw error;
  }

  await assertRegularFile(receiverPath, "Candidate receiver");
  if (path.basename(receiverPath) !== manifest.receiverFile) {
    fail("Candidate receiver filename does not match the manifest.");
  }
  if (await sha256(receiverPath) !== manifest.receiverSha256) {
    fail("Receiver SHA-256 does not match the candidate manifest.");
  }

  const bundlePath = path.join(path.dirname(manifestPath), manifest.bundleFile);
  await assertRegularFile(bundlePath, "Candidate bundle");
  if (await sha256(bundlePath) !== manifest.bundleSha256) {
    fail("Bundle SHA-256 does not match the candidate manifest.");
  }

  const stagingRoot = await mkdtemp(path.join(targetParent, `.codex-dynamic-skin-restore-${manifest.candidateSha.slice(0, 12)}-`));
  const stagedCheckout = path.join(stagingRoot, "checkout");
  try {
    run("git", ["clone", "--no-checkout", bundlePath, stagedCheckout], targetParent);
    run("git", ["bundle", "verify", bundlePath], stagedCheckout);
    run("git", ["checkout", "--detach", manifest.candidateSha], stagedCheckout);
    run(
      process.execPath,
      [path.join(stagedCheckout, "tools", "verify-candidate-worktree.mjs"), manifest.candidateSha],
      stagedCheckout,
    );
    await assertTargetAbsent(targetPath);
    await rename(stagedCheckout, targetPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  console.log(`Windows candidate restored: ${targetPath}`);
  console.log(`Candidate SHA: ${manifest.candidateSha}`);
  console.log(`Bundle SHA-256: ${manifest.bundleSha256}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Windows candidate restore failed.");
  process.exitCode = 1;
});
