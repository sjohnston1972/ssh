import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
