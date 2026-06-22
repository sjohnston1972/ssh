import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { resolveTileDir, safeChildPath } from '../src/files.js';

const tiles = [
  { label: 'Open', path: 'C:\\open' },
  { label: 'Boss', path: 'C:\\boss', allow: ['boss@x'] },
];

test('resolveTileDir returns dir for configured+allowed tile', () => {
  assert.equal(resolveTileDir(tiles, 'C:\\open', 'anyone@x'), 'C:\\open');
  assert.equal(resolveTileDir(tiles, 'C:\\boss', 'boss@x'), 'C:\\boss');
});
test('resolveTileDir null for unknown path or disallowed identity', () => {
  assert.equal(resolveTileDir(tiles, 'C:\\nope', 'a@x'), null);
  assert.equal(resolveTileDir(tiles, 'C:\\boss', 'peon@x'), null);
});
test('safeChildPath keeps inside dir, strips traversal', () => {
  assert.equal(safeChildPath('C:\\d', 'file.txt'), resolve('C:\\d', 'file.txt'));
  assert.equal(safeChildPath('C:\\d', '..\\..\\evil'), resolve('C:\\d', 'evil'));
  assert.equal(safeChildPath('C:\\d', 'a/b/c.txt'), resolve('C:\\d', 'c.txt'));
  assert.equal(safeChildPath('C:\\d', '..'), null);
  assert.equal(safeChildPath('C:\\d', ''), null);
});
test('safeChildPath can never escape dir for absolute/drive-relative names', () => {
  const dir = resolve('C:\\d');
  // Security invariant: result is either null (rejected) or strictly inside dir — never outside.
  for (const name of ['C:\\Windows\\System32\\evil.dll', '/etc/passwd', 'C:evil', '\\\\server\\share\\x', 'C:\\']) {
    const r = safeChildPath('C:\\d', name);
    assert.ok(r === null || r.startsWith(dir + sep), `escaped for name=${name}: ${r}`);
  }
});
