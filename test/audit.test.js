import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLogger } from '../src/audit.js';

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
