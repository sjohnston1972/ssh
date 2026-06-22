import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLogger, pruneOldLogs, readRecentAudit } from '../src/audit.js';

test('writes ndjson event lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const log = createAuditLogger(dir);
  log.event('session_start', { email: 'a@b.com', path: 'C:\\x' });
  log.command('a@b.com', 'dir');
  const file = join(dir, readdirSync(dir)[0]);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'session_start');
  assert.equal(lines[0].email, 'a@b.com');
  assert.equal(lines[1].type, 'command');
  assert.equal(lines[1].line, 'dir');
});

test('pruneOldLogs deletes only files older than retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aud-'));
  writeFileSync(join(dir, 'audit-2000-01-01.log'), 'x\n');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `audit-${today}.log`), 'y\n');
  writeFileSync(join(dir, 'notes.txt'), 'keep\n');
  pruneOldLogs(dir, 30);
  const left = readdirSync(dir);
  assert.ok(!left.includes('audit-2000-01-01.log'));
  assert.ok(left.includes(`audit-${today}.log`));
  assert.ok(left.includes('notes.txt'));
});

test('readRecentAudit returns newest-first and tolerates malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aud2-'));
  writeFileSync(join(dir, 'audit-2024-01-01.log'), JSON.stringify({ ts: 'a', type: 'one' }) + '\nNOT JSON\n' + JSON.stringify({ ts: 'b', type: 'two' }) + '\n');
  const rows = readRecentAudit(dir, 10);
  assert.equal(rows[0].type, 'two');   // newest (last line) first
  assert.equal(rows[1].type, 'one');
  assert.equal(rows.length, 2);        // malformed skipped
});
