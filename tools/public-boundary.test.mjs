import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { scanPublicBoundary } from "./verify-public-boundary.mjs";

const execFileAsync = promisify(execFile);
const blockedProductName = String.fromCharCode(119, 97, 105, 102, 117, 120);
const blockedInternalPath = String.fromCharCode(
  112, 114, 111, 102, 105, 108, 101, 45, 116, 111, 107, 101, 110,
);

test("reachable-history scanning uses one batch object stream", async () => {
  const source = await fs.readFile(
    new URL("./verify-public-boundary.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /\["cat-file",\s*"--batch"\]/u);
  assert.doesNotMatch(source, /\["cat-file",\s*"-[tp]"/u);
});

async function createRepository(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-public-boundary-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Boundary Test"], { cwd: root });
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

async function addIndexOnlyFile(root, relative, contents) {
  const blobSource = path.join(root, ".git", "boundary-index-blob");
  await fs.writeFile(blobSource, contents);
  const { stdout } = await execFileAsync("git", ["hash-object", "-w", blobSource], { cwd: root });
  await fs.rm(blobSource, { force: true });
  await execFileAsync(
    "git",
    ["update-index", "--add", "--cacheinfo", `100644,${stdout.trim()},${relative}`],
    { cwd: root },
  );
}

test("accepts a clean tracked source tree and reachable history", async (t) => {
  const root = await createRepository({ "README.md": "Dynamic theme center\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await scanPublicBoundary({ root });

  assert.equal(result.ok, true);
  assert.equal(result.files, 1);
  assert.equal(result.workingFiles, 1);
  assert.ok(result.gitObjects > 0);
});

test("rejects the retired product name without storing that name in this repository", async (t) => {
  const root = await createRepository({ "notes.txt": `retired=${blockedProductName}\n` });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    scanPublicBoundary({ root }),
    /forbidden content/u,
  );
});

test("rejects forbidden content in an untracked working-tree file", async (t) => {
  const root = await createRepository({ "README.md": "Dynamic theme center\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "untracked-notes.txt"), `retired=${blockedProductName}\n`);

  await assert.rejects(
    scanPublicBoundary({ root }),
    /forbidden content/u,
  );
});

test("rejects tracked symbolic links", async (t) => {
  const root = await createRepository({ "target.txt": "safe\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink("target.txt", path.join(root, "link.txt"));
  await execFileAsync("git", ["add", "link.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "add link"], { cwd: root });

  await assert.rejects(
    scanPublicBoundary({ root }),
    /symbolic link/u,
  );
});

test("rejects restricted internal module paths without naming them in source", async (t) => {
  const root = await createRepository({ [`modules/${blockedInternalPath}/index.js`]: "export {};\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    scanPublicBoundary({ root }),
    /restricted path/u,
  );
});

test("rejects paths that collide on case-insensitive filesystems", async (t) => {
  const root = await createRepository({ "Theme.js": "export const upper = true;\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addIndexOnlyFile(root, "theme.js", "export const lower = true;\n");

  await assert.rejects(
    scanPublicBoundary({ root }),
    /case-insensitive path collision/u,
  );
});

test("rejects Windows reserved device names", async (t) => {
  const root = await createRepository({ "docs/CON.txt": "not portable\n" });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    scanPublicBoundary({ root }),
    /Windows-reserved path/u,
  );
});
