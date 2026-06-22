import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTiles } from '../src/config.js';

const createdDirs = [];

function tmpConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  createdDirs.push(dir);
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('loads valid tiles and applies defaults', () => {
  const p = tmpConfig({ tiles: [{ path: 'C:\\a' }, { label: 'B', path: 'C:\\b', icon: '📁' }] });
  const tiles = loadTiles(p);
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].path, 'C:\\a');
  assert.equal(tiles[0].label, 'C:\\a');      // label defaults to path
  assert.equal(tiles[0].icon, '📁');           // icon defaults to 📁
  assert.equal(tiles[1].label, 'B');
});

test('throws when tiles is not an array', () => {
  const p = tmpConfig({ tiles: 'nope' });
  assert.throws(() => loadTiles(p), /tiles must be an array/);
});

test('throws when a tile is missing path', () => {
  const p = tmpConfig({ tiles: [{ label: 'no path' }] });
  assert.throws(() => loadTiles(p), /missing path/);
});

test('cleanup temp directories', () => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});
