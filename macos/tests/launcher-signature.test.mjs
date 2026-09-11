import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const macos = fileURLToPath(new URL('..', import.meta.url));
const builder = path.join(macos, 'scripts/build-theme-launcher.sh');
const native = { skip: process.platform !== 'darwin' };
const roots = [];
let signedFixture;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function temporaryDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdss-signature-test-'));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function requirement(app) {
  const result = await run('/usr/bin/codesign', ['-d', '-r-', app]);
  assert.equal(result.code, 0);
  const text = result.stdout.match(/^designated => (.+)$/m)?.[1];
  assert.ok(text, 'the signed fixture has a designated requirement');
  return text;
}

async function signedApp(t) {
  if (!signedFixture) signedFixture = (async () => {
    const identities = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    const identity = identities.stdout.match(/^\s*\d+\)\s+([0-9A-F]{40})\b/m)?.[1];
    if (!identity) return null;
    const root = await temporaryDirectory();
    const app = path.join(root, 'Original.app');
    const built = await run('/bin/bash', [builder, '--output', app, '--engine-root', path.join(root, 'engine'), '--sign-identity', identity]);
    assert.equal(built.code, 0, built.stderr);
    // An extra, valid requirement catches builders that silently regenerate it.
    const original = await requirement(app);
    const signed = await run('/usr/bin/codesign', ['--force', '--timestamp=none', '--sign', identity,
      '--requirements', `=designated => ${original} and ! (identifier "example.other-launcher")`, app]);
    assert.equal(signed.code, 0, 'the temporary fixture must be signed');
    return { app, identity };
  })();
  const fixture = await signedFixture;
  if (!fixture) t.skip('no local code-signing identity');
  return fixture;
}

async function snapshot(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else files.push([path.relative(directory, filename), createHash('sha256').update(await fs.readFile(filename)).digest('hex')]);
    }
  }
  await visit(directory);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

async function isolatedSigner(identities = []) {
  const root = await temporaryDirectory();
  const sourceRoot = path.join(root, 'source/macos');
  const scripts = path.join(sourceRoot, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.cp(path.join(macos, 'launcher'), path.join(sourceRoot, 'launcher'), { recursive: true });
  await fs.cp(path.join(macos, 'integration'), path.join(sourceRoot, 'integration'), { recursive: true });
  // Simulate only Keychain enumeration; actual signing still uses codesign.
  // No real keychain or keychain search list is changed.
  const security = path.join(root, 'security');
  const listed = identities.map((identity, index) => `  ${index + 1}) ${identity} "Fixture Identity"`).join('\n');
  await fs.writeFile(security, `#!/bin/bash\n[ "$*" = "find-identity -v -p codesigning" ] || exit 95\nprintf '%s\\n' '${listed}' '     ${identities.length} valid identities found'\n`, { mode: 0o700 });
  const source = await fs.readFile(builder, 'utf8');
  await fs.writeFile(path.join(scripts, 'build-theme-launcher.sh'), source.replaceAll('/usr/bin/security', security));
  await fs.copyFile(path.join(macos, 'scripts/install-theme-launcher.sh'), path.join(scripts, 'install-theme-launcher.sh'));
  // Even a broken installer can execute only this inert fixture, never a launcher.
  await fs.writeFile(path.join(sourceRoot, 'launcher/ThemeLauncher.swift'), 'import Foundation\nexit(0)\n');
  return { root, builder: path.join(scripts, 'build-theme-launcher.sh'), installer: path.join(scripts, 'install-theme-launcher.sh') };
}

async function installationFixture(signed, identities) {
  const f = await isolatedSigner(identities);
  const apps = path.join(f.root, 'Applications');
  const app = path.join(apps, 'Codex Theme Launcher.app');
  await fs.cp(signed.app, app, { recursive: true });
  const engine = path.join(f.root, 'engine');
  await fs.mkdir(path.join(engine, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(engine, 'scripts/open-dream-skin-macos.sh'), '#!/bin/bash\nexit 99\n');
  const official = path.join(f.root, 'Official.app');
  await fs.mkdir(path.join(official, 'Contents'), { recursive: true });
  await fs.writeFile(path.join(official, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  const state = path.join(f.root, 'state');
  return { ...f, app, state, args: [f.installer, '--engine-root', engine, '--applications-dir', apps, '--state-dir', state, '--codex-app', official] };
}

test('rebuilding a signed launcher preserves its exact designated requirement', native, async (t) => {
  const fixture = await signedApp(t);
  if (!fixture) return;
  const root = await temporaryDirectory();
  const app = path.join(root, 'Updated.app');
  const result = await run('/bin/bash', [builder, '--output', app, '--engine-root', path.join(root, 'different engine'),
    '--port', '19432', '--preserve-signature-from', fixture.app]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await requirement(app) === await requirement(fixture.app), 'designated requirements are exactly equal');
  assert.equal((await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${await requirement(fixture.app)}`, app])).code, 0);
  assert.notDeepEqual(await snapshot(app), await snapshot(fixture.app), 'the test compares different builds');
});

test('a signed upgrade refuses an ad-hoc override without creating output or modifying the original', native, async (t) => {
  const fixture = await signedApp(t);
  if (!fixture) return;
  const before = await snapshot(fixture.app);
  const root = await temporaryDirectory();
  const app = path.join(root, 'Updated.app');
  const result = await run('/bin/bash', [builder, '--output', app, '--preserve-signature-from', fixture.app, '--sign-identity', '-']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot override.*signing identity/i);
  assert.equal(await fs.access(app).then(() => true, () => false), false);
  assert.deepEqual(await snapshot(fixture.app), before);
});

test('missing original certificate fails installation before replacing the signed app', native, async (t) => {
  const fixture = await signedApp(t);
  if (!fixture) return;
  const f = await installationFixture(fixture, []);
  const before = await snapshot(f.app);
  const result = await run('/bin/bash', f.args, { env: { ...process.env, CDSS_CODESIGN_IDENTITY: '' } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing launcher.*signing identity.*unavailable/i);
  assert.deepEqual(await snapshot(f.app), before);
  assert.deepEqual(await fs.readdir(f.state), []);
});

test('installer preserves the existing identity when another identity appears first', native, async (t) => {
  const fixture = await signedApp(t);
  if (!fixture) return;
  const f = await installationFixture(fixture, ['0'.repeat(40), fixture.identity]);
  const before = await snapshot(f.app);
  const originalRequirement = await requirement(f.app);
  const result = await run('/bin/bash', f.args, { env: { ...process.env, CDSS_CODESIGN_IDENTITY: '' } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await requirement(f.app) === originalRequirement, 'the installed app retains its exact requirement');
  assert.notDeepEqual(await snapshot(f.app), before, 'a new temporary build was installed');
  const backups = (await fs.readdir(f.state)).filter((name) => name.startsWith('previous-app.'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await snapshot(path.join(f.state, backups[0], 'Codex Theme Launcher.app')), before);
});

test('a modified existing signature is rejected before producing an update', native, async (t) => {
  const fixture = await signedApp(t);
  if (!fixture) return;
  const root = await temporaryDirectory();
  const previous = path.join(root, 'Modified.app');
  await fs.cp(fixture.app, previous, { recursive: true });
  assert.equal((await run('/usr/bin/plutil', ['-replace', 'CDSSPort', '-integer', '19431', path.join(previous, 'Contents/Info.plist')])).code, 0);
  const before = await snapshot(previous);
  const app = path.join(root, 'Updated.app');
  const result = await run('/bin/bash', [builder, '--output', app, '--preserve-signature-from', previous]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing launcher signature is invalid/i);
  assert.equal(await fs.access(app).then(() => true, () => false), false);
  assert.deepEqual(await snapshot(previous), before);
});

test('first and existing ad-hoc installations without a certificate remain compatible', native, async () => {
  const f = await isolatedSigner();
  const app = path.join(f.root, 'First.app');
  const result = await run('/bin/bash', [f.builder, '--output', app], { env: { ...process.env, CDSS_CODESIGN_IDENTITY: '' } });
  assert.equal(result.code, 0, result.stderr);
  const details = await run('/usr/bin/codesign', ['-dvv', app]);
  assert.equal(details.code, 0);
  assert.match(details.stderr, /Signature=adhoc/);
  assert.equal((await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])).code, 0);
  const update = path.join(f.root, 'Second.app');
  const updated = await run('/bin/bash', [f.builder, '--output', update, '--preserve-signature-from', app], { env: { ...process.env, CDSS_CODESIGN_IDENTITY: '' } });
  assert.equal(updated.code, 0, updated.stderr);
  assert.match((await run('/usr/bin/codesign', ['-dvv', update])).stderr, /Signature=adhoc/);
});
