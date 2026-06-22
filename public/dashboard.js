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
    el.onclick = () => { location.href = `/terminal?path=${encodeURIComponent(t.path)}&label=${encodeURIComponent(t.label)}`; };
    grid.appendChild(el);
  }
}
load();
