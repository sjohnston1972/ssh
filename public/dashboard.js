async function load() {
  const [tiles, me] = await Promise.all([
    fetch('/api/tiles').then(r => r.json()),
    fetch('/api/me').then(r => r.json()).catch(() => ({ email: '' })),
  ]);
  document.getElementById('who').textContent = me.email ? `signed in as ${me.email}` : '';
  const grid = document.getElementById('grid');
  for (const t of tiles) {
    const el = document.createElement('div');
    el.className = 'tile';
    const icon = document.createElement('div'); icon.className = 'icon'; icon.textContent = t.icon;
    const label = document.createElement('div'); label.className = 'label'; label.textContent = t.label;
    const path = document.createElement('div'); path.className = 'path'; path.textContent = t.path;
    el.append(icon, label, path);
    const open = () => { location.href = `/terminal?path=${encodeURIComponent(t.path)}&label=${encodeURIComponent(t.label)}`; };
    el.onclick = () => { if (t.intro) showIntro(t, open); else open(); };
    grid.appendChild(el);
  }
}

function showIntro(tile, onOk) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const icon = document.createElement('div');
  icon.className = 'modal-icon';
  icon.textContent = tile.icon || '🔥';

  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = (tile.intro && tile.intro.title) || `Open ${tile.label}`;

  const lines = document.createElement('ul');
  lines.className = 'modal-lines';
  for (const line of (tile.intro && tile.intro.lines) || []) {
    const li = document.createElement('li');
    li.textContent = line;
    lines.appendChild(li);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn-secondary';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.className = 'btn-primary';
  ok.textContent = 'OK';
  actions.append(cancel, ok);

  modal.append(icon, title, lines, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  ok.focus();

  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { close(); onOk(); }
  };
  document.addEventListener('keydown', onKey);
  cancel.onclick = close;
  ok.onclick = () => { close(); onOk(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

load();
