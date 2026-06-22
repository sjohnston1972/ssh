let allTiles = [];

async function load() {
  const [tiles, me] = await Promise.all([
    fetch('/api/tiles').then((r) => r.json()),
    fetch('/api/me').then((r) => r.json()).catch(() => ({ email: '' })),
  ]);
  document.getElementById('who').textContent = me.email ? `signed in as ${me.email}` : '';
  allTiles = tiles;
  render('');
}

function makeTile(t) {
  const el = document.createElement('div');
  el.className = 'tile';
  const icon = document.createElement('div'); icon.className = 'icon'; icon.textContent = t.icon;
  const label = document.createElement('div'); label.className = 'label'; label.textContent = t.label;
  const path = document.createElement('div'); path.className = 'path'; path.textContent = t.path;
  el.append(icon, label, path);
  const open = () => { location.href = `/terminal?path=${encodeURIComponent(t.path)}&label=${encodeURIComponent(t.label)}`; };
  el.onclick = () => { if (t.intro) showIntro(t, open); else open(); };
  return el;
}

function render(query) {
  const root = document.getElementById('grid-root');
  root.textContent = '';
  const q = query.trim().toLowerCase();
  const matches = allTiles.filter((t) =>
    !q || t.label.toLowerCase().includes(q) || t.path.toLowerCase().includes(q));
  const groups = new Map();
  for (const t of matches) {
    const g = t.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const [g, items] of groups) {
    if (g) { const h = document.createElement('h2'); h.className = 'group-heading'; h.textContent = g; root.appendChild(h); }
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const t of items) grid.appendChild(makeTile(t));
    root.appendChild(grid);
  }
  if (!matches.length) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = 'No matching tiles.'; root.appendChild(e); }
}

function showIntro(tile, onOk) {
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  const modal = document.createElement('div'); modal.className = 'modal';
  const icon = document.createElement('div'); icon.className = 'modal-icon'; icon.textContent = tile.icon || '🔥';
  const title = document.createElement('h2'); title.className = 'modal-title'; title.textContent = (tile.intro && tile.intro.title) || `Open ${tile.label}`;
  const lines = document.createElement('ul'); lines.className = 'modal-lines';
  for (const line of (tile.intro && tile.intro.lines) || []) { const li = document.createElement('li'); li.textContent = line; lines.appendChild(li); }
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel';
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'OK';
  actions.append(cancel, ok); modal.append(icon, title, lines, actions); overlay.appendChild(modal);
  document.body.appendChild(overlay); ok.focus();
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'Enter') { close(); onOk(); } };
  document.addEventListener('keydown', onKey);
  cancel.onclick = close; ok.onclick = () => { close(); onOk(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

document.getElementById('tile-search').addEventListener('input', (e) => render(e.target.value));
load();
