import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileAllowed, visibleTiles } from '../src/authz.js';

test('no allow list ⇒ allowed for anyone', () => {
  assert.equal(tileAllowed({ path: 'C:\\x' }, 'a@x'), true);
  assert.equal(tileAllowed({ path: 'C:\\x', allow: [] }, 'a@x'), true);
});
test('allow list restricts by email (case-insensitive)', () => {
  const t = { path: 'C:\\x', allow: ['Owner@X.com'] };
  assert.equal(tileAllowed(t, 'owner@x.com'), true);
  assert.equal(tileAllowed(t, 'other@x'), false);
});
test('undefined tile ⇒ not allowed', () => {
  assert.equal(tileAllowed(undefined, 'a@x'), false);
});
test('visibleTiles filters per identity', () => {
  const tiles = [{ path: 'a' }, { path: 'b', allow: ['boss@x'] }];
  assert.deepEqual(visibleTiles(tiles, 'boss@x').map((t) => t.path), ['a', 'b']);
  assert.deepEqual(visibleTiles(tiles, 'nobody@x').map((t) => t.path), ['a']);
});
