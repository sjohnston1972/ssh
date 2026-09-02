import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveTileDir, resolveTileSubdir, safeChildPath } from '../src/files.js';

const NUL = String.fromCharCode(0);

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
  assert.equal(safeChildPath('C:\\d', 'a' + NUL + 'b.txt'), null);  // null byte rejected
});
test('safeChildPath can never escape dir for absolute/drive-relative names', () => {
  const dir = resolve('C:\\d');
  // Security invariant: result is either null (rejected) or strictly inside dir — never outside.
  for (const name of ['C:\\Windows\\System32\\evil.dll', '/etc/passwd', 'C:evil', '\\\\server\\share\\x', 'C:\\']) {
    const r = safeChildPath('C:\\d', name);
    assert.ok(r === null || r.startsWith(dir + sep), `escaped for name=${name}: ${r}`);
  }
});

// --- #9: resolveTileSubdir (containment-safe subdirectory resolver) ---

function makeTileTree() {
  const tileDir = mkdtempSync(join(tmpdir(), 'tile-'));
  mkdirSync(join(tileDir, 'sub'));
  mkdirSync(join(tileDir, 'sub', 'nested'));
  writeFileSync(join(tileDir, 'sub', 'inside.txt'), 'hi');
  return tileDir;
}

test('resolveTileSubdir with no subpath behaves exactly like resolveTileDir (tile root)', () => {
  const tileDir = makeTileTree();
  const tiles2 = [{ label: 'T', path: tileDir }];
  assert.equal(resolveTileSubdir(tiles2, tileDir, '', 'a@x'), resolve(tileDir));
  assert.equal(resolveTileSubdir(tiles2, tileDir, null, 'a@x'), resolve(tileDir));
  assert.equal(resolveTileSubdir(tiles2, tileDir, undefined, 'a@x'), resolve(tileDir));
});

test('resolveTileSubdir resolves a real subdirectory inside the tile, nested or not', () => {
  const tileDir = makeTileTree();
  const tiles2 = [{ label: 'T', path: tileDir }];
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'sub', 'a@x'), resolve(tileDir, 'sub'));
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'sub/nested', 'a@x'), resolve(tileDir, 'sub', 'nested'));
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'sub\\nested', 'a@x'), resolve(tileDir, 'sub', 'nested'));
});

test('resolveTileSubdir refuses an unknown tile or a disallowed identity, regardless of subpath', () => {
  assert.equal(resolveTileSubdir(tiles, 'C:\\nope', 'sub', 'a@x'), null);
  assert.equal(resolveTileSubdir(tiles, 'C:\\boss', 'sub', 'peon@x'), null);
});

test('resolveTileSubdir refuses ".." traversal out of the tile root', () => {
  const tileDir = makeTileTree();
  const tiles2 = [{ label: 'T', path: tileDir }];
  for (const payload of ['..', '..\\..', 'sub\\..\\..', '..\\..\\..\\Windows', 'sub/../../escape']) {
    assert.equal(resolveTileSubdir(tiles2, tileDir, payload, 'a@x'), null, `should refuse: ${payload}`);
  }
});

test('resolveTileSubdir refuses absolute paths, including a different drive and a UNC path', () => {
  const tileDir = makeTileTree();
  const tiles2 = [{ label: 'T', path: tileDir }];
  for (const payload of ['C:\\Windows\\System32', 'D:\\evil', '\\\\server\\share\\x', resolve(tileDir, '..')]) {
    assert.equal(resolveTileSubdir(tiles2, tileDir, payload, 'a@x'), null, `should refuse: ${payload}`);
  }
});

test('resolveTileSubdir refuses a null byte in the subpath', () => {
  const tileDir = makeTileTree();
  const tiles2 = [{ label: 'T', path: tileDir }];
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'sub' + NUL + 'x', 'a@x'), null);
});

test('resolveTileSubdir refuses a directory symlink (junction) inside the tile that escapes it', () => {
  const tileDir = makeTileTree();
  const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET');
  const linkPath = join(tileDir, 'escape-link');
  try {
    symlinkSync(outsideDir, linkPath, 'junction');
  } catch {
    // Environment cannot create even a junction (unusual, but don't fail the suite over it).
    return;
  }
  const tiles2 = [{ label: 'T', path: tileDir }];
  // The symlink target itself resolves outside the tile...
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'escape-link', 'a@x'), null);
  // ...and so does anything requested "through" it.
  assert.equal(resolveTileSubdir(tiles2, tileDir, 'escape-link\\secret.txt', 'a@x'), null);
});
