import { readFileSync } from 'node:fs';

export function loadTiles(configPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('config: invalid JSON in ' + configPath + ': ' + err.message);
    }
    throw new Error('config: cannot read ' + configPath + ': ' + err.message);
  }
  if (!Array.isArray(raw.tiles)) {
    throw new Error('config: tiles must be an array');
  }
  return raw.tiles.map((t, i) => {
    if (!t || typeof t.path !== 'string' || !t.path) {
      throw new Error(`config: tile ${i} missing path`);
    }
    const tile = { label: t.label || t.path, path: t.path, icon: t.icon || '📁' };
    if (typeof t.command === 'string' && t.command) tile.command = t.command;
    if (typeof t.shell === 'string' && t.shell) tile.shell = t.shell;
    if (typeof t.group === 'string' && t.group) tile.group = t.group;
    if (t.intro && typeof t.intro === 'object') tile.intro = t.intro;
    if (t.allow !== undefined) {
      if (!Array.isArray(t.allow) || t.allow.some((a) => typeof a !== 'string')) {
        throw new Error(`config: tile ${i} allow must be an array of strings`);
      }
      tile.allow = t.allow;
    }
    return tile;
  });
}
