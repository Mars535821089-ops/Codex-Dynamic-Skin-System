import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../scripts/install-theme-launcher.sh', import.meta.url));
test('installs an app and Desktop shortcut without executing the engine; refuses unrelated replacements', { skip: process.platform !== 'darwin' }, async (t) => {
  assert.equal(await fs.access(installer).then(() => true, () => false), true, 'launcher installer must exist');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skin-icon-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = path.join(root, 'Engine With Spaces');
  const apps = path.join(root, 'Applications');
  const desktop = path.join(root, 'Desktop');
  const state = path.join(root, 'State');
  await fs.mkdir(path.join(engine, 'scripts'), { recursive: true });
  // If the installer runs this instead of --check it will fail the test.
  await fs.writeFile(path.join(engine, 'scripts/open-dream-skin-macos.sh'), '#!/bin/bash\nexit 91\n');
  const args = [installer, '--engine-root', engine, '--applications-dir', apps,
    '--state-dir', state, '--desktop', '--desktop-dir', desktop, '--port', '24341'];
  const first = spawnSync('/bin/bash', args, { encoding: 'utf8', timeout: 120000 });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const app = path.join(apps, 'Codex Theme Launcher.app');
  const shortcut = path.join(desktop, 'Codex Theme Launcher.app');
  assert.equal(await fs.realpath(shortcut), await fs.realpath(app));
  const check = spawnSync(path.join(app, 'Contents/MacOS/CodexThemeLauncher'), ['--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).port, 24341);
  assert.equal(await fs.realpath(JSON.parse(check.stdout).engineRoot), await fs.realpath(engine));
  await fs.unlink(shortcut);
  await fs.mkdir(shortcut);
  const blocked = spawnSync('/bin/bash', args, { encoding: 'utf8', timeout: 120000 });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /unrelated|overwrite/i);
  assert.equal((await fs.stat(shortcut)).isDirectory(), true);
  assert.equal((await fs.stat(app)).isDirectory(), true);
});

const native = { skip: process.platform !== 'darwin' };
const helperSource = fileURLToPath(new URL('../integration/LauncherFiles.swift', import.meta.url));
let helperRoot, helperBuild;
after(async () => { if (helperRoot) await fs.rm(helperRoot, { recursive: true, force: true }); });

async function helper() {
  if (!helperBuild) helperBuild = (async () => {
    assert.equal(await fs.access(helperSource).then(() => true, () => false), true,
      'The exact-path installation helper must exist.');
    helperRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-files-build-'));
    const binary = path.join(helperRoot, 'launcher-files');
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', helperSource, '-o', binary], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    return binary;
  })();
  return helperBuild;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-files-case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const apps = path.join(root, 'Applications');
  await fs.mkdir(apps);
  return { root, apps, target: path.join(apps, 'Codex Theme Launcher.app'),
    state: path.join(root, 'State'), shortcut: path.join(root, 'Desktop', 'Codex Theme Launcher.app') };
}

async function appFixture(location, marker = 'new', identifier = 'io.github.codex-dynamic-skin-system.launcher') {
  await fs.mkdir(path.join(location, 'Contents'), { recursive: true });
  await fs.writeFile(path.join(location, 'Contents/Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`);
  await fs.writeFile(path.join(location, 'marker'), marker);
  return location;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function install(f, source, { desktop = false } = {}) {
  return run(await helper(), ['install', '--source', source, '--target', f.target,
    '--state-dir', f.state, ...(desktop ? ['--shortcut', f.shortcut] : [])]);
}

test('publication refuses unrelated directories and symlinks without moving or nesting any content', native, async (t) => {
  const f = await fixture(t);
  const source = await appFixture(path.join(f.root, 'Staged.app'));
  await appFixture(f.target, 'unrelated', 'example.unrelated');
  const directory = await install(f, source);
  assert.notEqual(directory.status, 0);
  assert.match(directory.stderr, /unrelated|identity/i);
  assert.equal(await fs.readFile(path.join(f.target, 'marker'), 'utf8'), 'unrelated');
  assert.deepEqual((await fs.readdir(f.target)).sort(), ['Contents', 'marker']);
  await fs.rename(f.target, path.join(f.root, 'Unrelated.app'));
  await fs.symlink(path.join(f.root, 'Unrelated.app'), f.target);
  const linked = await install(f, source);
  assert.notEqual(linked.status, 0);
  assert.equal(await fs.readlink(f.target), path.join(f.root, 'Unrelated.app'));
  assert.equal(await fs.access(source).then(() => true, () => false), true);
});

test('a failed publication restores the previous launcher at the exact target', native, async (t) => {
  const f = await fixture(t);
  await appFixture(f.target, 'previous');
  const result = await install(f, path.join(f.root, 'Disappeared After Build.app'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publish/i);
  assert.match(result.stderr, /restored/i);
  assert.equal(await fs.readFile(path.join(f.target, 'marker'), 'utf8'), 'previous');
  assert.deepEqual((await fs.readdir(f.target)).sort(), ['Contents', 'marker']);
});

test('a successful replacement keeps exactly one complete previous launcher', native, async (t) => {
  const f = await fixture(t);
  await appFixture(f.target, 'previous');
  const source = await appFixture(path.join(f.root, 'Staged.app'), 'replacement');
  const result = await install(f, source);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.installed, true);
  assert.equal(await fs.readFile(path.join(f.target, 'marker'), 'utf8'), 'replacement');
  assert.equal(await fs.readFile(path.join(report.backup, 'Codex Theme Launcher.app', 'marker'), 'utf8'), 'previous');
  assert.equal(await fs.access(source).then(() => true, () => false), false);
});

test('Desktop directories and incorrect symlinks are preserved and report the completed app installation', native, async (t) => {
  for (const collision of ['directory', 'symlink']) {
    const f = await fixture(t);
    await appFixture(f.target, 'previous');
    const source = await appFixture(path.join(f.root, 'Staged.app'), 'replacement');
    await fs.mkdir(path.dirname(f.shortcut));
    if (collision === 'directory') await fs.mkdir(f.shortcut);
    else await fs.symlink('/unrelated-dangling-fixture', f.shortcut);
    const result = await install(f, source, { desktop: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shortcut/i);
    assert.match(result.stderr, /remains installed/i);
    assert.match(result.stderr, /Previous launcher retained:/);
    assert.equal(await fs.readFile(path.join(f.target, 'marker'), 'utf8'), 'replacement');
    if (collision === 'directory') assert.deepEqual(await fs.readdir(f.shortcut), []);
    else assert.equal(await fs.readlink(f.shortcut), '/unrelated-dangling-fixture');
  }
});

test('an existing correct Desktop symlink is idempotent', native, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.shortcut));
  await fs.symlink(f.target, f.shortcut);
  const inode = (await fs.lstat(f.shortcut)).ino;
  const result = await install(f, await appFixture(path.join(f.root, 'Staged.app')), { desktop: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await fs.lstat(f.shortcut)).ino, inode);
  assert.equal(await fs.readlink(f.shortcut), f.target);
});

test('concurrent installations serialize publication and preserve every replaced app without nesting', native, async (t) => {
  const f = await fixture(t);
  const sources = await Promise.all(Array.from({ length: 5 }, (_, i) => appFixture(path.join(f.root, `Stage-${i}.app`), String(i))));
  const results = await Promise.all(sources.map((source) => install(f, source, { desktop: true })));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await fs.readdir(f.target)).sort(), ['Contents', 'marker']);
  assert.equal(await fs.realpath(f.shortcut), await fs.realpath(f.target));
  const reports = results.map((result) => JSON.parse(result.stdout));
  const backups = reports.map((report) => report.backup).filter(Boolean);
  assert.equal(backups.length, 4);
  const markers = [await fs.readFile(path.join(f.target, 'marker'), 'utf8')];
  for (const backup of backups) markers.push(await fs.readFile(path.join(backup, 'Codex Theme Launcher.app', 'marker'), 'utf8'));
  assert.deepEqual(markers.sort(), ['0', '1', '2', '3', '4']);
});

test('the production rename boundary refuses a directory arriving after validation', native, async (t) => {
  const f = await fixture(t);
  const production = await fs.readFile(helperSource, 'utf8');
  // Run the actual publication primitive, with its only dependencies, to make
  // the post-validation collision deterministic. No app APIs enter this harness.
  const functions = ['fail', 'posixFailure', 'moveExclusive'].map((name) => {
    const body = production.match(new RegExp(`^private func ${name}\\([^]*?^\\}`, 'mu'))?.[0];
    assert.ok(body, `Production ${name} function must be present.`);
    return body;
  }).join('\n');
  const harness = path.join(f.root, 'ExactPublication.swift');
  const binary = path.join(f.root, 'exact-publication');
  await fs.writeFile(harness, `import Darwin\nimport Foundation\n${functions}\ndo {
    try moveExclusive(CommandLine.arguments[1], CommandLine.arguments[2])
  } catch { print(error.localizedDescription); exit(1) }\n`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', harness, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const source = await appFixture(path.join(f.root, 'Staged.app'), 'staged');
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, 'keep.txt'), 'new arrival');
  const result = await run(binary, [source, f.target]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fs.readdir(f.target), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(source, 'marker'), 'utf8'), 'staged');
  await fs.unlink(path.join(f.target, 'keep.txt'));
  const empty = await run(binary, [source, f.target]);
  assert.notEqual(empty.status, 0, 'Even an empty destination directory must not be replaced.');
  assert.deepEqual(await fs.readdir(f.target), []);
  await fs.rmdir(f.target);
  await fs.symlink('/unrelated-dangling-fixture', f.target);
  const linked = await run(binary, [source, f.target]);
  assert.notEqual(linked.status, 0);
  assert.equal(await fs.readlink(f.target), '/unrelated-dangling-fixture');
  assert.equal(await fs.readFile(path.join(source, 'marker'), 'utf8'), 'staged');
});
