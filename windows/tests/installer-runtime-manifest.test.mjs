import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(windowsRoot, "assets", "runtime-required-files.json");

async function listFiles(root, relativeRoot) {
  const found = [];
  const absoluteRoot = path.join(root, relativeRoot);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) found.push(path.relative(root, absolute).replaceAll(path.sep, "\\"));
      else throw new Error(`unsupported runtime entry: ${absolute}`);
    }
  }
  await visit(absoluteRoot);
  return found;
}

test("one manifest covers every Windows runtime dependency and packaged-only file", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema, "codex-dream-skin-runtime-files/1");

  const actualRuntimeFiles = ["VERSION"];
  for (const directory of ["assets", "presets", "scripts"]) {
    actualRuntimeFiles.push(...await listFiles(windowsRoot, directory));
  }
  assert.deepEqual(
    [...manifest.required].sort(),
    actualRuntimeFiles.sort(),
    "the completeness gate must cover every source runtime file, including transitive modules",
  );
  assert.deepEqual([...manifest.packagedAdditions].sort(), [
    "assets\\codex-dream-skin.ico",
    "runtime\\node\\LICENSE",
    "runtime\\node\\node.exe",
  ]);
});

test("builder, bootstrap, and transactional engine install consume the same manifest", async () => {
  const sources = await Promise.all([
    "installer/build-release.ps1",
    "installer/setup-bootstrap.ps1",
    "scripts/common-windows.ps1",
  ].map((relative) => fs.readFile(path.join(windowsRoot, relative), "utf8")));

  for (const source of sources) {
    assert.match(source, /runtime-required-files\.json/);
    assert.match(source, /\.required/);
  }
  assert.match(sources[0], /codex-dream-skin-runtime-files\/1/);
  assert.match(sources[2], /codex-dream-skin-runtime-files\/1/);
  assert.match(sources[1], /Read-DreamSkinRuntimeFileManifest/);
  assert.match(sources[0], /\.packagedAdditions/);
  assert.match(sources[1], /\.packagedAdditions/);
});
