import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeSessionActivity } from '../scripts/session-activity.mjs';
import { probeSessionActivity as probeMac } from '../../macos/scripts/dream-skin-autostart.mjs';

test('Windows idle guard exactly matches the stable Mac lifecycle probe', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-win-activity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = Date.now() - 5000;
  const file = path.join(root, 'task.jsonl');
  const line = (type) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type } }) + '\n';
  for (const [content, status] of [['', 'idle'], [line('task_started'), 'busy'],
    [line('task_started') + line('task_complete'), 'idle'],
    [line('task_started') + line('turn_aborted'), 'idle'], ['broken\n', 'unknown'],
    [JSON.stringify({ timestamp: new Date().toISOString(), type: 'other' }), 'unknown']]) {
    await fs.writeFile(file, content);
    const actual = await probeSessionActivity(root, started);
    assert.equal(actual.status, status);
    assert.deepEqual(actual, await probeMac(root, started));
  }
  assert.equal((await probeSessionActivity(path.join(root, 'missing'), started)).status, 'unknown');
});

test('activity CLI returns structured unknown without authorizing missing evidence', () => {
  const script = fileURLToPath(new URL('../scripts/session-activity.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--sessions-root', os.tmpdir() + '/missing-ds-evidence',
    '--app-started-at-ms', String(Date.now())], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'unknown', activeCount: 0 });
});
