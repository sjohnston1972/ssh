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
    el.innerHTML = `<div class="icon">${t.icon}</div>
      <div class="label">${t.label}</div>
      <div class="path">${t.path}</div>`;
    el.onclick = () => { location.href = `/terminal?path=${encodeURIComponent(t.path)}&label=${encodeURIComponent(t.label)}`; };
    grid.appendChild(el);
  }
}
load();
