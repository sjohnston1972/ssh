export function tileAllowed(tile, email) {
  if (!tile) return false;
  if (tile.allow == null || !Array.isArray(tile.allow) || tile.allow.length === 0) return true;
  const e = String(email || '').toLowerCase();
  return tile.allow.some((a) => String(a).toLowerCase() === e);
}

export function visibleTiles(tiles, email) {
  return tiles.filter((t) => tileAllowed(t, email));
}
