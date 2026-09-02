import { resolve, relative, basename, dirname, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { tileAllowed } from './authz.js';

export function resolveTileDir(tiles, path, email) {
  const tile = tiles.find((t) => t.path === path);
  if (!tile || !tileAllowed(tile, email)) return null;
  return tile.path;
}

export function safeChildPath(dir, name) {
  const raw = String(name || '');
  if (raw.includes('\0')) return null;
  const base = basename(raw);
  if (!base || base === '.' || base === '..') return null;
  const target = resolve(dir, base);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) return null;
  return target;
}

// `target` must be exactly `root`, or lexically nested under it. Using a plain string
// prefix check (rather than relative(...).startsWith('..')) is deliberate: relative()
// between two different Windows drives (or a UNC path) returns the second path
// unchanged instead of a leading '..', which would slip past a relative()-only check.
// A prefix check has no such gap — a target on another drive, or any other path that
// isn't lexically inside root, simply won't start with `root + sep`.
function contained(root, target) {
  return target === root || target.startsWith(root + sep);
}

// realpathSync requires the full path to exist. To catch a symlink escape even when the
// requested (non-existent) leaf itself hasn't been created, walk up to the nearest
// existing ancestor, resolve *that* through the filesystem (collapsing any symlinks in
// it), then re-append the still-nonexistent remainder literally.
function realpathDeepest(p) {
  try { return realpathSync(p); } catch { /* fall through to ancestor walk */ }
  const parent = dirname(p);
  if (parent === p) return p; // reached a filesystem root; nothing left to resolve
  return join(realpathDeepest(parent), basename(p));
}

// Resolve a subdirectory within a tile, refusing to escape the tile root.
//
// Containment is checked twice: once lexically against the resolved (but not yet
// filesystem-checked) path — rejecting '..' traversal and absolute/UNC/other-drive
// paths outright — and once again against the *real* filesystem path (symlinks
// resolved), so a subpath that looks contained on paper but passes through a symlink
// pointing outside the tile is rejected too.
//
// Returns the resolved absolute directory path, or null if: the tile is unknown or the
// caller isn't allowed to use it, the subpath contains a null byte, or the subpath
// escapes the tile root either lexically or after resolving symlinks.
export function resolveTileSubdir(tiles, path, subpath, email) {
  const dir = resolveTileDir(tiles, path, email);
  if (dir == null) return null;
  const raw = subpath == null ? '' : String(subpath);
  if (raw.includes('\0')) return null;

  const tileRoot = resolve(dir);
  const target = resolve(tileRoot, raw);
  if (!contained(tileRoot, target)) return null;

  const realRoot = realpathDeepest(tileRoot);
  const realTarget = realpathDeepest(target);
  if (!contained(realRoot, realTarget)) return null;

  return target;
}
