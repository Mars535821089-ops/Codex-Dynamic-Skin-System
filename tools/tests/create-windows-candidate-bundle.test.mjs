import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "../..");

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function git(cwd, ...args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function makeCandidate() {
  const testRoot = path.join(os.tmpdir(), "codex-dynamic-skin-tests");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, "dream-skin-windows-candidate-"));
  await mkdir(path.join(root, "tools"), { recursive: true });
  await cp(
    path.join(projectRoot, "tools", "verify-candidate-worktree.mjs"),
    path.join(root, "tools", "verify-candidate-worktree.mjs"),
  );
  await cp(
    path.join(projectRoot, "tools", "create-windows-candidate-bundle.mjs"),
    path.join(root, "tools", "create-windows-candidate-bundle.mjs"),
  );
  await cp(
    path.join(projectRoot, "tools", "restore-windows-candidate.mjs"),
    path.join(root, "tools", "restore-windows-candidate.mjs"),
  );
  await writeFile(path.join(root, ".gitignore"), "/release/\n/work/\n/.planning/\n", "utf8");
  await writeFile(path.join(root, "PRODUCT.md"), "# Candidate\n", "utf8");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Dream Skin Test");
  git(root, "config", "user.email", "dream-skin-test@example.invalid");
  git(root, "add", "-A");
  git(root, "commit", "-m", "candidate");
  return root;
}

async function createCandidateDelivery(root) {
  const candidateSha = git(root, "rev-parse", "HEAD");
  const result = run(
    process.execPath,
    ["tools/create-windows-candidate-bundle.mjs", "--candidate", candidateSha],
    root,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const releaseRoot = path.join(root, "release", "windows-candidate");
  const names = await readdir(releaseRoot);
  const bundleName = names.find((name) => name.endsWith(".bundle"));
  const manifestName = names.find((name) => name.endsWith(".json"));
  const receiverName = names.find((name) => name.endsWith("-restore.mjs"));
  assert.ok(bundleName);
  assert.ok(manifestName);
  assert.ok(receiverName);
  return {
    candidateSha,
    releaseRoot,
    bundleName,
    manifestName,
    manifestPath: path.join(releaseRoot, manifestName),
    receiverName,
    receiverPath: path.join(releaseRoot, receiverName),
  };
}

test("Windows candidate bundle restores the exact clean commit without local evidence", async () => {
  const root = await makeCandidate();
  const restored = `${root}-restored`;
  try {
    await mkdir(path.join(root, "work", "windows-native-acceptance"), { recursive: true });
    await mkdir(path.join(root, ".planning"), { recursive: true });
    await writeFile(path.join(root, "work", "windows-native-acceptance", "local.json"), "{}\n");
    await writeFile(path.join(root, ".planning", "local.md"), "local only\n");

    const {
      candidateSha,
      releaseRoot,
      bundleName,
      manifestName,
    } = await createCandidateDelivery(root);
    const names = await readdir(releaseRoot);

    const manifest = JSON.parse(await readFile(path.join(releaseRoot, manifestName), "utf8"));
    assert.equal(manifest.schema, "codex-dynamic-skin-windows-candidate/2");
    assert.equal(manifest.candidateSha, candidateSha);
    assert.equal(manifest.bundleFile, bundleName);
    const bundleBytes = await readFile(path.join(releaseRoot, bundleName));
    assert.equal(createHash("sha256").update(bundleBytes).digest("hex"), manifest.bundleSha256);
    assert.equal(manifest.receiverFile, names.find((name) => name.endsWith("-restore.mjs")));
    const receiverBytes = await readFile(path.join(releaseRoot, manifest.receiverFile));
    assert.equal(createHash("sha256").update(receiverBytes).digest("hex"), manifest.receiverSha256);

    const clone = run("git", ["clone", path.join(releaseRoot, bundleName), restored], root);
    assert.equal(clone.status, 0, clone.stderr || clone.stdout);
    assert.equal(git(restored, "rev-parse", "HEAD"), candidateSha);
    assert.equal(run(process.execPath, ["tools/verify-candidate-worktree.mjs", candidateSha], restored).status, 0);
    assert.equal(names.includes("local.json"), false);
    assert.equal(names.includes("local.md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test("Windows candidate receiver verifies and restores the exact delivery", async () => {
  const root = await makeCandidate();
  const target = `${root}-received`;
  try {
    const delivery = await createCandidateDelivery(root);
    const result = run(
      process.execPath,
      [
        delivery.receiverPath,
        "--manifest",
        delivery.manifestPath,
        "--target",
        target,
      ],
      root,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git(target, "rev-parse", "HEAD"), delivery.candidateSha);
    assert.equal(git(target, "status", "--porcelain=v1", "--untracked-files=all"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("Windows candidate receiver rejects a tampered bundle without publishing a checkout", async () => {
  const root = await makeCandidate();
  const target = `${root}-tampered-target`;
  try {
    const delivery = await createCandidateDelivery(root);
    await writeFile(path.join(delivery.releaseRoot, delivery.bundleName), "tampered\n", { flag: "a" });
    const result = run(
      process.execPath,
      [
        delivery.receiverPath,
        "--manifest",
        delivery.manifestPath,
        "--target",
        target,
      ],
      root,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bundle SHA-256 does not match the candidate manifest/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("Windows candidate receiver rejects a tampered receiver without publishing a checkout", async () => {
  const root = await makeCandidate();
  const target = `${root}-tampered-receiver-target`;
  try {
    const delivery = await createCandidateDelivery(root);
    await writeFile(delivery.receiverPath, "\n// tampered\n", { flag: "a" });
    const result = run(
      process.execPath,
      [
        delivery.receiverPath,
        "--manifest",
        delivery.manifestPath,
        "--target",
        target,
      ],
      root,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Receiver SHA-256 does not match the candidate manifest/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("Windows candidate receiver never replaces an existing target", async () => {
  const root = await makeCandidate();
  const target = `${root}-existing-target`;
  const marker = path.join(target, "keep.txt");
  try {
    const delivery = await createCandidateDelivery(root);
    await mkdir(target, { recursive: true });
    await writeFile(marker, "keep\n", "utf8");
    const result = run(
      process.execPath,
      [
        delivery.receiverPath,
        "--manifest",
        delivery.manifestPath,
        "--target",
        target,
      ],
      root,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Target checkout already exists/);
    assert.equal(await readFile(marker, "utf8"), "keep\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
