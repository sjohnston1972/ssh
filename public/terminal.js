const params = new URLSearchParams(location.search);
const tilePath = params.get('path') || '';
document.getElementById('path').textContent = (params.get('label') || '') + '  ' + tilePath;

const statusEl = document.getElementById('status');
const reconnectBtn = document.getElementById('reconnect');
const idleBanner = document.getElementById('idle-banner');
function setStatus(state, text) { statusEl.dataset.state = state; statusEl.textContent = text; }

const THEMES = {
  dark: { background: '#000000', foreground: '#e5e7eb', cursor: '#e5e7eb' },
  light: { background: '#ffffff', foreground: '#1f2937', cursor: '#1f2937', selectionBackground: '#bfdbfe' },
};
let fontSize = Math.min(24, Math.max(10, Number(localStorage.getItem('term-font') || 14)));
let themeName = localStorage.getItem('term-theme') === 'light' ? 'light' : 'dark';

const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize, theme: THEMES[themeName] });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
const search = new SearchAddon.SearchAddon();
term.loadAddon(search);
term.open(document.getElementById('terminal-host'));

let ws, attempts = 0, intentionalClose = false, idleTimer = null;

function syncSize() {
  try { fit.fit(); } catch {}
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}
function sendInput(data) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); }

function showIdle(seconds) {
  idleBanner.hidden = false; let left = seconds; clearInterval(idleTimer);
  const render = () => { idleBanner.textContent = `⚠ Idle — closing in ${left}s (press any key to stay)`; };
  render(); idleTimer = setInterval(() => { left -= 1; if (left <= 0) clearInterval(idleTimer); else render(); }, 1000);
}
function hideIdle() { clearInterval(idleTimer); idleBanner.hidden = true; }

function connect() {
  setStatus(attempts === 0 ? 'connecting' : 'reconnecting', attempts === 0 ? 'connecting…' : 'reconnecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    attempts = 0; setStatus('connected', '● connected'); reconnectBtn.hidden = true;
    try { fit.fit(); } catch {}
    ws.send(JSON.stringify({ type: 'start', tilePath, cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'restore') { term.reset(); term.write(msg.data); }
    else if (msg.type === 'exit') term.write('\r\n[process exited]\r\n');
    else if (msg.type === 'error') term.write(`\r\n[${msg.message}]\r\n`);
    else if (msg.type === 'idle-warning') showIdle(msg.seconds);
    else if (msg.type === 'idle-cancel') hideIdle();
    else if (msg.type === 'taken-over') { intentionalClose = true; setStatus('disconnected', '○ opened in another tab'); term.write('\r\n[session opened in another tab]\r\n'); }
  };
  ws.onclose = () => {
    if (intentionalClose) return;
    const delays = [500, 1000, 2000, 5000];
    const delay = delays[Math.min(attempts, delays.length - 1)];
    attempts += 1;
    if (attempts > 40) { setStatus('disconnected', '○ disconnected'); reconnectBtn.hidden = false; return; }
    setStatus('reconnecting', '◌ reconnecting…');
    setTimeout(connect, delay);
  };
}
connect();

// --- SP3: search / copy / paste via custom key handler ---
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
function openSearch() { searchBar.hidden = false; searchInput.focus(); searchInput.select(); }
function closeSearch() { searchBar.hidden = true; term.focus(); }

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'f') { openSearch(); return false; }
  if (e.ctrlKey && key === 'c' && (e.shiftKey || term.hasSelection())) {
    const sel = term.getSelection();
    if (sel) { navigator.clipboard?.writeText(sel).catch(() => {}); return false; }
    // no selection: let the key pass through (Ctrl+C interrupts; Ctrl+Shift+C reaches the browser, e.g. DevTools)
  }
  if (e.ctrlKey && key === 'v') {
    navigator.clipboard?.readText().then((t) => { if (t) sendInput(t); }).catch(() => {});
    return false;
  }
  return true;
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.shiftKey ? search.findPrevious(searchInput.value) : search.findNext(searchInput.value); }
  else if (e.key === 'Escape') closeSearch();
});
document.getElementById('search-next').onclick = () => search.findNext(searchInput.value);
document.getElementById('search-prev').onclick = () => search.findPrevious(searchInput.value);
document.getElementById('search-close').onclick = closeSearch;
document.getElementById('btn-search').onclick = openSearch;

// --- SP3: font size / theme / fullscreen ---
function setFont(n) { fontSize = Math.min(24, Math.max(10, n)); term.options.fontSize = fontSize; localStorage.setItem('term-font', String(fontSize)); try { fit.fit(); } catch {} syncSize(); }
document.getElementById('btn-font-inc').onclick = () => setFont(fontSize + 1);
document.getElementById('btn-font-dec').onclick = () => setFont(fontSize - 1);
document.getElementById('btn-theme').onclick = () => {
  themeName = themeName === 'dark' ? 'light' : 'dark';
  term.options.theme = THEMES[themeName]; localStorage.setItem('term-theme', themeName);
};
document.getElementById('btn-fullscreen').onclick = () => {
  const host = document.getElementById('terminal-host');
  if (!document.fullscreenElement) host.requestFullscreen?.(); else document.exitFullscreen?.();
};

// --- SP3: mobile on-screen keys (semantic tokens → escape sequences) ---
const KEY_SEQ = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', 'ctrl-c': '\x03' };
for (const btn of document.querySelectorAll('#mobile-keys button')) {
  btn.addEventListener('click', (e) => { e.preventDefault(); sendInput(KEY_SEQ[btn.dataset.key] || ''); });
}

// --- preserved SP1 sizing + buttons ---
term.onData((d) => sendInput(d));
window.addEventListener('resize', syncSize);
if (window.ResizeObserver) new ResizeObserver(syncSize).observe(document.getElementById('terminal-host'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSize);
window.addEventListener('load', syncSize);
document.addEventListener('fullscreenchange', syncSize);
reconnectBtn.onclick = () => location.reload();
document.getElementById('restart').onclick = (e) => { e.preventDefault(); location.reload(); };

// --- SP4/SP5: files panel (with subdirectory navigation) ---
const filesPanel = document.getElementById('files-panel');
const filesList = document.getElementById('files-list');
const filesBreadcrumb = document.getElementById('files-breadcrumb');
const fileInput = document.getElementById('file-input');
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }

// Current directory within the tile, as a list of path segments ([] = tile root). The
// backend enforces containment (see resolveTileSubdir); the UI only ever appends a
// clicked entry's own name or truncates to an earlier breadcrumb segment, so it never
// constructs a subpath that could climb above the tile root.
let currentSubdir = [];
function subpathParam() { return currentSubdir.join('/'); }
function apiUrl(base, extra) {
  const p = new URLSearchParams({ path: tilePath, ...extra });
  const sub = subpathParam();
  if (sub) p.set('subpath', sub);
  return base + '?' + p.toString();
}

function renderBreadcrumb() {
  filesBreadcrumb.textContent = '';
  const crumbs = [{ label: '🏠 root', depth: 0 }, ...currentSubdir.map((name, i) => ({ label: name, depth: i + 1 }))];
  crumbs.forEach((c, i) => {
    if (i > 0) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; filesBreadcrumb.appendChild(sep); }
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = c.label;
    const isCurrent = c.depth === currentSubdir.length;
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.onclick = () => { currentSubdir = currentSubdir.slice(0, c.depth); loadFiles(); };
    filesBreadcrumb.appendChild(btn);
  });
}

async function loadFiles() {
  filesList.textContent = '';
  renderBreadcrumb();
  let entries = [];
  try { entries = await (await fetch(apiUrl('/api/files'))).json(); } catch {}
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const e of entries) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'fname'; name.textContent = (e.isDir ? '📂 ' : '📄 ') + e.name;
    li.appendChild(name);
    if (e.isDir) {
      li.classList.add('dirent');
      li.title = 'Open folder';
      li.onclick = () => { currentSubdir = [...currentSubdir, e.name]; loadFiles(); };
    } else {
      const meta = document.createElement('span'); meta.className = 'fmeta'; meta.textContent = fmtSize(e.size);
      const dl = document.createElement('a'); dl.className = 'ctl'; dl.textContent = '⬇';
      dl.href = apiUrl('/api/download', { file: e.name });
      li.append(meta, dl);
    }
    filesList.appendChild(li);
  }
  if (!entries.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = '(empty)'; filesList.appendChild(li); }
}
document.getElementById('btn-files').onclick = () => { filesPanel.hidden = !filesPanel.hidden; if (!filesPanel.hidden) loadFiles(); };
document.getElementById('files-close').onclick = () => { filesPanel.hidden = true; };
document.getElementById('files-refresh').onclick = loadFiles;
fileInput.onchange = async () => {
  for (const f of fileInput.files) {
    try { await fetch(apiUrl('/api/upload', { name: f.name }), { method: 'PUT', body: f }); } catch {}
  }
  fileInput.value = '';
  loadFiles();
};
