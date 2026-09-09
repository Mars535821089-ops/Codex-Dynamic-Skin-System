import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Exercise the real plist transform, never the user's Dock preferences.
const source = fileURLToPath(new URL('../integration/DockEntry.swift', import.meta.url));
let root, binary, official, launcher;
const mac = process.platform === 'darwin';
before(async () => {
  if (!mac) return;
  assert.equal(await fs.access(source).then(() => true, () => false), true, 'Dock entry tool must exist');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skin-dock-test-'));
  binary = path.join(root, 'dock-entry');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  official = path.join(root, 'Official App.app');
  launcher = path.join(root, 'Theme Launcher.app');
  for (const [app, id] of [[official, 'com.openai.codex'], [launcher, 'io.github.codex-dynamic-skin-system.launcher']]) {
    await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
  }
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function tile(id, app, bundle = 'com.openai.codex') {
  return { GUID: id, 'tile-type': 'file-tile', 'tile-data': {
    'bundle-identifier': bundle, 'file-label': 'Original', book: 'stale-bookmark',
    'file-data': { _CFURLString: pathToFileURL(app + '/').href, _CFURLStringType: 15 },
  } };
}
async function run(entries, extra = [], { xml = false } = {}) {
  const dir = await fs.mkdtemp(path.join(root, 'case-'));
  const input = path.join(dir, 'before.plist'), output = path.join(dir, 'after.plist');
  await fs.writeFile(input, xml ? entries : JSON.stringify({ 'persistent-apps': entries, unrelated: 'keep' }));
  const convert = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', input], { encoding: 'utf8' });
  assert.equal(convert.status, 0, convert.stderr);
  const result = spawnSync(binary, ['--input', input, '--output', output, '--target', official, '--launcher', launcher, ...extra], { encoding: 'utf8' });
  let value;
  if (result.status === 0 && xml) {
    const valid = spawnSync('/usr/bin/plutil', ['-lint', output], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  } else if (result.status === 0) {
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', output], { encoding: 'utf8' });
    assert.equal(converted.status, 0, converted.stderr);
    value = JSON.parse(converted.stdout);
  }
  return { result, value, input, output };
}

function extractXML(plist, key) {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'xml1', '-o', '-', plist], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('replaces only the exact official tile, preserves order and unrelated settings', { skip: !mac }, async () => {
  const other = tile(1, path.join(root, 'Other.app'), 'example.other');
  const classic = tile(3, path.join(root, 'Classic.app'), 'com.openai.chat');
  const { result, value } = await run([other, tile(2, official), classic]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, 1);
  assert.deepEqual(value['persistent-apps'][0], other);
  assert.deepEqual(value['persistent-apps'][2], classic);
  assert.equal(value.unrelated, 'keep');
  const changed = value['persistent-apps'][1];
  assert.equal(changed.GUID, 2);
  assert.equal(changed['tile-data']['file-data']._CFURLString, pathToFileURL(launcher + '/').href);
  assert.equal(changed['tile-data']['bundle-identifier'], 'io.github.codex-dynamic-skin-system.launcher');
  assert.equal(changed['tile-data'].book, undefined, 'old bookmark must not redirect back to the official app');
});
test('second installation is a no-op and does not create duplicate icons', { skip: !mac }, async () => {
  const first = await run([tile(2, official)]);
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = await run(first.value['persistent-apps']);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(JSON.parse(second.result.stdout).changed, 0);
  assert.deepEqual(second.value, first.value);
});
test('a same-path tile with different bundle identity is not changed', { skip: !mac }, async () => {
  const entry = tile(8, official, 'example.unrelated');
  const { result, value } = await run([entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(value['persistent-apps'], [entry]);
});
test('restore uses backup GUIDs while preserving newly added unrelated tiles', { skip: !mac }, async () => {
  const original = tile(2, official);
  const first = await run([original]);
  assert.equal(first.result.status, 0, first.result.stderr);
  const added = tile(6, path.join(root, 'New App.app'), 'example.new');
  const restored = await run([...first.value['persistent-apps'], added], ['--restore', '--backup', first.input]);
  assert.equal(restored.result.status, 0, restored.result.stderr);
  assert.deepEqual(restored.value['persistent-apps'], [original, added]);
});
test('restore preserves a separately pinned launcher absent from the backup', { skip: !mac }, async () => {
  const original = tile(2, official);
  const first = await run([original]);
  assert.equal(first.result.status, 0, first.result.stderr);
  const added = tile(999, launcher, 'io.github.codex-dynamic-skin-system.launcher');
  const restored = await run([added, ...first.value['persistent-apps']], ['--restore', '--backup', first.input]);
  assert.equal(restored.result.status, 0, restored.result.stderr);
  assert.equal(JSON.parse(restored.result.stdout).changed, 1);
  assert.deepEqual(restored.value['persistent-apps'], [added, original]);
});
test('a remote file URL with the same path is not a local target', { skip: !mac }, async () => {
  const entry = tile(2, official);
  entry['tile-data']['file-data']._CFURLString = pathToFileURL(official + '/').href.replace('file:///', 'file://remote-host.invalid/');
  const { result, value } = await run([entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, 0);
  assert.deepEqual(value['persistent-apps'], [entry]);
});
test('a localhost file URL still identifies the local target', { skip: !mac }, async () => {
  const entry = tile(2, official);
  entry['tile-data']['file-data']._CFURLString = pathToFileURL(official + '/').href.replace('file:///', 'file://localhost/');
  const { result, value } = await run([entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, 1);
  assert.equal(value['persistent-apps'][0]['tile-data']['bundle-identifier'], 'io.github.codex-dynamic-skin-system.launcher');
});
test('duplicate target GUIDs are rejected before producing a replacement', { skip: !mac }, async () => {
  const { result, output } = await run([tile(4, official), tile(4, official)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GUID/i);
  assert.equal(await fs.access(output).then(() => true, () => false), false);
});
test('restore still rejects ambiguous original GUIDs in a backup', { skip: !mac }, async () => {
  const original = tile(4, official);
  const first = await run([original]);
  assert.equal(first.result.status, 0, first.result.stderr);
  const backup = path.join(path.dirname(first.input), 'ambiguous-backup.plist');
  await fs.writeFile(backup, JSON.stringify({ 'persistent-apps': [original, original] }));
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', backup], { encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  const { result, output } = await run(first.value['persistent-apps'], ['--restore', '--backup', backup]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one|ambiguous/i);
  assert.equal(await fs.access(output).then(() => true, () => false), false);
});
test('binary bookmark Data survives untouched tiles and backup restoration', { skip: !mac }, async () => {
  const bookmark = 'AAECA//+gA==';
  const xmlTile = (guid, app, bundle) => `<dict>
    <key>GUID</key><integer>${guid}</integer><key>tile-type</key><string>file-tile</string>
    <key>tile-data</key><dict><key>bundle-identifier</key><string>${bundle}</string>
    <key>file-label</key><string>Original</string><key>book</key><data>${bookmark}</data>
    <key>file-data</key><dict><key>_CFURLString</key><string>${pathToFileURL(app + '/').href}</string>
    <key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
  const fixture = `<?xml version="1.0"?><plist version="1.0"><dict><key>persistent-apps</key><array>
    ${xmlTile(1, path.join(root, 'Other.app'), 'example.other')}${xmlTile(2, official, 'com.openai.codex')}
    </array><key>unrelated</key><data>${bookmark}</data></dict></plist>`;
  const first = await run(fixture, [], { xml: true });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(JSON.parse(first.result.stdout).changed, 1);
  assert.equal(extractXML(first.output, 'persistent-apps.0'), extractXML(first.input, 'persistent-apps.0'));
  assert.equal(extractXML(first.output, 'unrelated'), extractXML(first.input, 'unrelated'));
  const dataXML = extractXML(first.output, 'persistent-apps.0.tile-data.book');
  const base64 = dataXML.match(/<data>([\s\S]*?)<\/data>/)?.[1].replace(/\s/g, '');
  assert.deepEqual(Buffer.from(base64 ?? '', 'base64'), Buffer.from([0, 1, 2, 3, 255, 254, 128]));
  const replaced = extractXML(first.output, 'persistent-apps.1');
  assert.doesNotMatch(replaced, /<key>book<\/key>|<data>/);
  const restored = await run(await fs.readFile(first.output, 'utf8'), ['--restore', '--backup', first.input], { xml: true });
  assert.equal(restored.result.status, 0, restored.result.stderr);
  assert.equal(extractXML(restored.output, 'persistent-apps'), extractXML(first.input, 'persistent-apps'));
});
test('malformed preferences fail without producing a replacement', { skip: !mac }, async () => {
  const { result, output } = await run('not-an-array');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /persistent-apps/);
  assert.equal(await fs.access(output).then(() => true, () => false), false);
});
test('offline fixtures cannot be combined with live preference writes', { skip: !mac }, async () => {
  const { result } = await run([tile(2, official)], ['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline|input|apply/i);
});
