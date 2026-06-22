import { resolve, relative, basename } from 'node:path';
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
