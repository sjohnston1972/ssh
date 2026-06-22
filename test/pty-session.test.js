import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCmd } from '../src/pty-session.js';

test('defaults to PowerShell and runs a PowerShell-only command', async () => {
  // Write-Output is a PowerShell cmdlet; cmd.exe would error on it, so a match proves the PS default.
  const term = spawnCmd({ cwd: process.cwd(), fallbackDir: process.cwd(), cols: 80, rows: 24 });
  const out = await new Promise((resolve) => {
    let buf = '';
    term.onData((d) => { buf += d; if (buf.includes('PSPONG')) resolve(buf); });
    term.write('Write-Output PSPONG\r');
    setTimeout(() => resolve(buf), 6000);
  });
  term.kill();
  assert.match(out, /PSPONG/);
});

test('honors an explicit shell override (cmd.exe)', async () => {
  // "ver" is a cmd.exe builtin that prints the Windows version banner.
  const term = spawnCmd({ cwd: process.cwd(), fallbackDir: process.cwd(), cols: 80, rows: 24, shell: 'cmd.exe' });
  const out = await new Promise((resolve) => {
    let buf = '';
    term.onData((d) => { buf += d; if (/Windows/i.test(buf)) resolve(buf); });
    term.write('ver\r');
    setTimeout(() => resolve(buf), 6000);
  });
  term.kill();
  assert.match(out, /Windows/i);
});

test('falls back when cwd does not exist', async () => {
  const term = spawnCmd({ cwd: 'C:\\does\\not\\exist\\xyz', fallbackDir: process.cwd(), cols: 80, rows: 24 });
  assert.ok(term);  // did not throw
  term.kill();
});
