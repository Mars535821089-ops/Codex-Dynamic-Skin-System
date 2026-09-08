import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(windowsRoot, "assets", "runtime-required-files.json");

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await fs.readFile(path.join(windowsRoot, relativePath)))
    .digest("hex");
}

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

  const actualRuntimeFiles = ["VERSION", "repository.json"];
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

test("installer bootstrap rejects missing or conflicting action switches", async () => {
  const bootstrap = await fs.readFile(
    path.join(windowsRoot, "installer/setup-bootstrap.ps1"),
    "utf8",
  );
  assert.match(bootstrap, /\$actionCount\s*=\s*@\(\$Install,\s*\$LaunchTray,\s*\$Uninstall\)/u);
  assert.match(bootstrap, /if \(\$actionCount -ne 1\)/u);
});

test("Windows release runtime download has a bounded network deadline", async () => {
  const builder = await fs.readFile(
    path.join(windowsRoot, "installer/build-release.ps1"),
    "utf8",
  );
  assert.match(
    builder,
    /Invoke-WebRequest[\s\S]{0,240}-Uri\s+"\$\(\$manifest\.url\)"[\s\S]{0,240}-TimeoutSec\s+60/u,
  );
});

test("Windows source install copies only manifest-approved runtime files", async () => {
  const source = await fs.readFile(
    path.join(windowsRoot, "scripts", "common-windows.ps1"),
    "utf8",
  );

  assert.match(source, /foreach \(\$relative in \$required\)[\s\S]*Copy-Item/u);
  assert.doesNotMatch(
    source,
    /Copy-Item\s+-LiteralPath \(Join-Path \$sourceRoot \$directoryName\)[\s\S]{0,160}-Recurse/u,
  );
  assert.match(source, /Runtime manifest input cannot be a reparse point/u);
  assert.match(
    source,
    /Ensure-DreamSkinManagedDirectory -Path \$stagedParent -Root \$stagingRoot/u,
  );
});

test("Windows release stages only manifest-approved payload files and rejects extras", async () => {
  const source = await fs.readFile(
    path.join(windowsRoot, "installer", "build-release.ps1"),
    "utf8",
  );

  assert.match(source, /function Copy-ReleaseManifestFiles/);
  assert.doesNotMatch(source, /function Copy-ReleaseDirectory/);
  assert.doesNotMatch(source, /Copy-ReleaseDirectory\s+-Source/);
  assert.match(source, /Unexpected staged installer payload file/);
  assert.match(source, /expectedPayloadFiles[\s\S]*actualPayloadFiles/);
});

test("Windows release pinned input hashes match the exact reviewed files", async () => {
  const source = await fs.readFile(
    path.join(windowsRoot, "installer", "build-release.ps1"),
    "utf8",
  );
  const pinned = Object.fromEntries(
    [...source.matchAll(/\$(\w+Sha256)\s*=\s*'([0-9a-f]{64})'/g)]
      .map((match) => [match[1], match[2]]),
  );

  assert.equal(
    pinned.innoChineseLanguageSha256,
    await sha256("installer/languages/ChineseSimplified.isl"),
  );
  assert.equal(
    pinned.innoSetupLicenseSha256,
    await sha256("installer/languages/Inno-Setup-License.txt"),
  );
  assert.equal(
    pinned.publicPresetImageSha256,
    await sha256("presets/preset-gothic-void-crusade/background.jpg"),
  );
  assert.equal(
    pinned.publicPresetThemeSha256,
    await sha256("presets/preset-gothic-void-crusade/theme.json"),
  );
});

test("Windows installer redistributes the license for its vendored Inno Setup language file", async () => {
  const [builder, installer, notice] = await Promise.all([
    fs.readFile(path.join(windowsRoot, "installer", "build-release.ps1"), "utf8"),
    fs.readFile(path.join(windowsRoot, "installer", "codex-dream-skin.iss"), "utf8"),
    fs.readFile(path.join(windowsRoot, "..", "macos", "NOTICE.md"), "utf8"),
  ]);

  assert.match(
    builder,
    /Copy-Item\s+-LiteralPath \$innoSetupLicensePath[\s\S]{0,180}Inno-Setup-License\.txt/u,
    "the reviewed Inno Setup license must be copied into the release staging tree",
  );
  assert.match(
    installer,
    /Source: "\{#StageRoot\}\\languages\\Inno-Setup-License\.txt"; DestDir: "\{app\}\\licenses";/u,
    "Setup.exe must install the Inno Setup license beside the application notices",
  );
  assert.match(notice, /Node\.js v22\.23\.1/u);
  assert.match(notice, /Inno Setup License/u);
});

test("Windows release refuses drift across every embedded runtime version", async () => {
  const source = await fs.readFile(
    path.join(windowsRoot, "installer", "build-release.ps1"),
    "utf8",
  );

  for (const [variable, file] of [
    ["macosCommonPath", "common-macos.sh"],
    ["macosInjectorPath", "injector.mjs"],
    ["windowsInjectorPath", "injector.mjs"],
  ]) {
    assert.match(source, new RegExp(`\\$${variable}\\s*=`));
    assert.match(source, new RegExp(`\\$${variable}[\\s\\S]+${file.replace(".", "\\.")}`));
    assert.match(source, new RegExp(`Assert-EmbeddedReleaseVersion -Path \\$${variable}`));
  }
  assert.match(source, /Assert-EmbeddedReleaseVersion/);
  assert.match(source, /Release versions differ/);
});
