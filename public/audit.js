const tbody = document.querySelector('#audit-table tbody');
function detail(r) {
  if (r.type === 'command') return r.line || '';
  if (r.path) return r.path + (r.name ? ' / ' + r.name : '') + (r.reason ? ' (' + r.reason + ')' : '');
  return r.reason || '';
}
async function load() {
  tbody.textContent = '';
  let rows = [];
  try { rows = await (await fetch('/api/audit?limit=500')).json(); } catch {}
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.ts || '', r.type || '', r.email || '', detail(r)]) {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (!rows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.textContent = 'No audit entries.'; tr.appendChild(td); tbody.appendChild(tr); }
}
document.getElementById('refresh').onclick = load;
load();
