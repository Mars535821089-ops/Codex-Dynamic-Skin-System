import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    candidateSha: null,
    outputRoot: path.join(projectRoot, "release", "windows-candidate"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate") {
      options.candidateSha = argv[++index] ?? null;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) fail("--output requires a directory.");
      options.outputRoot = path.resolve(projectRoot, value);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stderr) console.error(result.stderr.trim());
    fail("Could not create or verify the Windows candidate bundle.");
  }
  return capture ? result.stdout.trim() : "";
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

const { candidateSha: requestedSha, outputRoot } = parseArguments(process.argv.slice(2));
const candidateSha = requestedSha ?? run("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
  fail("Candidate SHA must be a lowercase 40-character Git SHA.");
}

run(process.execPath, [path.join(projectRoot, "tools", "verify-candidate-worktree.mjs"), candidateSha], {
  capture: false,
});

await mkdir(outputRoot, { recursive: true });
const stem = `CodexDynamicSkinSystem-windows-candidate-${candidateSha.slice(0, 12)}`;
const bundleName = `${stem}.bundle`;
const manifestName = `${stem}.json`;
const receiverName = `${stem}-restore.mjs`;
const bundlePath = path.join(outputRoot, bundleName);
const manifestPath = path.join(outputRoot, manifestName);
const receiverPath = path.join(outputRoot, receiverName);
if ((await exists(bundlePath)) || (await exists(manifestPath)) || (await exists(receiverPath))) {
  fail("Candidate output already exists; refusing to overwrite it.");
}

const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
const temporaryBundle = path.join(outputRoot, `.${stem}-${nonce}.bundle.tmp`);
const temporaryManifest = path.join(outputRoot, `.${stem}-${nonce}.json.tmp`);
const temporaryReceiver = path.join(outputRoot, `.${stem}-${nonce}-restore.mjs.tmp`);
let publishedBundle = false;
let publishedReceiver = false;

try {
  run("git", ["bundle", "create", temporaryBundle, "HEAD"]);
  run("git", ["bundle", "verify", temporaryBundle]);
  const bundleSha256 = await sha256(temporaryBundle);
  const receiverBytes = await readFile(path.join(projectRoot, "tools", "restore-windows-candidate.mjs"));
  const receiverSha256 = createHash("sha256").update(receiverBytes).digest("hex");
  await writeFile(temporaryReceiver, receiverBytes, { flag: "wx" });
  const manifest = {
    schema: "codex-dynamic-skin-windows-candidate/2",
    candidateSha,
    bundleFile: bundleName,
    bundleSha256,
    receiverFile: receiverName,
    receiverSha256,
    restore: [
      `git clone ${bundleName} Codex-Dynamic-Skin-System`,
      `git -C Codex-Dynamic-Skin-System checkout --detach ${candidateSha}`,
      `node Codex-Dynamic-Skin-System/tools/verify-candidate-worktree.mjs ${candidateSha}`,
    ],
  };
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryBundle, bundlePath);
  publishedBundle = true;
  await rename(temporaryReceiver, receiverPath);
  publishedReceiver = true;
  await rename(temporaryManifest, manifestPath);
  console.log(`Windows candidate bundle: ${bundleName}`);
  console.log(`Windows candidate receiver: ${receiverName}`);
  console.log(`Candidate SHA: ${candidateSha}`);
  console.log(`Bundle SHA-256: ${bundleSha256}`);
  console.log(`Receiver SHA-256: ${receiverSha256}`);
} catch (error) {
  await rm(temporaryBundle, { force: true });
  await rm(temporaryManifest, { force: true });
  await rm(temporaryReceiver, { force: true });
  if (publishedBundle) await rm(bundlePath, { force: true });
  if (publishedReceiver) await rm(receiverPath, { force: true });
  fail(error instanceof Error ? error.message : "Candidate bundle creation failed.");
}
