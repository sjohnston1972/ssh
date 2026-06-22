import { readFileSync } from 'node:fs';

export function loadTiles(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.tiles)) {
    throw new Error('config: tiles must be an array');
  }
  return raw.tiles.map((t, i) => {
    if (!t || typeof t.path !== 'string' || !t.path) {
      throw new Error(`config: tile ${i} missing path`);
    }
    return { label: t.label || t.path, path: t.path, icon: t.icon || '📁' };
  });
}
