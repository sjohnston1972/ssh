import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCmd } from '../src/pty-session.js';

test('spawns cmd.exe and echoes output', async () => {
  const term = spawnCmd({ cwd: process.cwd(), fallbackDir: process.cwd(), cols: 80, rows: 24 });
  const out = await new Promise((resolve) => {
    let buf = '';
    term.onData((d) => { buf += d; if (buf.includes('PONGTEST')) resolve(buf); });
    term.write('echo PONGTEST\r');
    setTimeout(() => resolve(buf), 4000);
  });
  term.kill();
  assert.match(out, /PONGTEST/);
});

test('falls back when cwd does not exist', async () => {
  const term = spawnCmd({ cwd: 'C:\\does\\not\\exist\\xyz', fallbackDir: process.cwd(), cols: 80, rows: 24 });
  assert.ok(term);  // did not throw
  term.kill();
});
