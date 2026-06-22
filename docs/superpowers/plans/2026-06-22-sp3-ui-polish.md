# SP3 — UI Polish Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Clickable links, in-terminal search, copy/paste, font-size + theme + fullscreen controls, mobile on-screen keys, and a searchable/grouped tile dashboard.

**Architecture:** Client-only except an optional tile `group` field. Two xterm addons (`web-links`, `search`) are vendored and loaded; `terminal.js` gains the controls while preserving all SP1 reconnect/status/idle behavior; `dashboard.js` gains live filter + grouping.

**Tech Stack:** Node v24 (ESM) server (unchanged logic), `@xterm/addon-web-links`, `@xterm/addon-search`, xterm client.

## Global Constraints

- ESM; `node --test test/*.test.js`; keep existing 41 tests green.
- Preserve SP1 (reconnect/backoff, status pill, restore, idle banner) and SP2 (CSP: addons are same-origin `'self'` scripts; `navigator.clipboard` needs no CSP grant).
- Bump asset versions to `?v=5` in both HTML files.
- Vendored globals (verify from the UMD dist after `npm run vendor`): `WebLinksAddon.WebLinksAddon`, `SearchAddon.SearchAddon` (mirror the existing `FitAddon.FitAddon` pattern). If a global differs, adapt the `new ...` call to match the actual export.

---

### Task 1: Vendor addons + terminal enhancements

**Files:**
- Modify: `scripts/copy-vendor.js`, `public/terminal.html`, `public/terminal.js`, `public/styles.css`
- (npm) install `@xterm/addon-web-links`, `@xterm/addon-search`

**Interfaces:** Consumes the SP1 WS protocol (unchanged). Adds no server messages.

- [ ] **Step 1: Install + vendor the addons.** 

```bash
cd /c/cloudflare_projects/ssh
npm install @xterm/addon-web-links @xterm/addon-search
```
Edit `scripts/copy-vendor.js` — add to the `files` array:
```javascript
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['@xterm/addon-search/lib/addon-search.js', 'addon-search.js'],
```
Run `npm run vendor`. Expected: prints copied lines for both. If a source path differs for the installed version, resolve with `node -e "console.log(require.resolve('@xterm/addon-web-links'))"` and adjust.

- [ ] **Step 2: Confirm the addon globals.**

Run:
```bash
node -e "const s=require('fs').readFileSync('public/vendor/addon-web-links.js','utf8'); console.log('web-links global hint:', /self\.(\w+)\s*=/.exec(s)?.[1] || 'check UMD'); const t=require('fs').readFileSync('public/vendor/addon-search.js','utf8'); console.log('search global hint:', /self\.(\w+)\s*=/.exec(t)?.[1] || 'check UMD');"
```
Expected: `WebLinksAddon` and `SearchAddon` (the class is `<Global>.<Global>`). Use whatever the file actually exports in Step 4.

- [ ] **Step 3: Update `public/terminal.html`** — load addons, add controls + search box + mobile toolbar; bump `?v=5`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>terminal · clydeford</title>
  <link rel="stylesheet" href="/styles.css?v=5" />
  <link rel="stylesheet" href="/vendor/xterm.css" />
</head>
<body>
  <div class="term-header">
    <a href="/">← tiles</a>
    <span class="path" id="path"></span>
    <span class="spacer"></span>
    <button id="btn-search" class="ctl" title="Search (Ctrl+F)">🔍</button>
    <button id="btn-font-dec" class="ctl" title="Smaller">A−</button>
    <button id="btn-font-inc" class="ctl" title="Larger">A+</button>
    <button id="btn-theme" class="ctl" title="Toggle theme">◐</button>
    <button id="btn-fullscreen" class="ctl" title="Fullscreen">⛶</button>
    <span class="status" id="status" data-state="connecting">connecting…</span>
    <button id="reconnect" class="status-btn" hidden>Reconnect</button>
    <a href="#" id="restart">restart</a>
  </div>
  <div id="search-bar" hidden>
    <input id="search-input" type="text" placeholder="find…" />
    <button id="search-prev" class="ctl" title="Previous">▲</button>
    <button id="search-next" class="ctl" title="Next">▼</button>
    <button id="search-close" class="ctl" title="Close (Esc)">✕</button>
  </div>
  <div id="idle-banner" hidden></div>
  <div id="terminal-host"></div>
  <div id="mobile-keys">
    <button data-seq="">Esc</button>
    <button data-seq="\t">Tab</button>
    <button data-seq="[A">↑</button>
    <button data-seq="[B">↓</button>
    <button data-seq="[D">←</button>
    <button data-seq="[C">→</button>
    <button data-seq="">^C</button>
  </div>
  <script src="/vendor/xterm.js"></script>
  <script src="/vendor/addon-fit.js"></script>
  <script src="/vendor/addon-web-links.js"></script>
  <script src="/vendor/addon-search.js"></script>
  <script src="/terminal.js?v=5"></script>
</body>
</html>
```

- [ ] **Step 4: Rewrite `public/terminal.js`** — preserves ALL SP1 logic, adds SP3 features.

```javascript
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

// --- SP3: copy / paste / search via custom key handler ---
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
    if (e.shiftKey) return false;
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

// --- SP3: mobile on-screen keys ---
for (const btn of document.querySelectorAll('#mobile-keys button')) {
  btn.addEventListener('click', (e) => { e.preventDefault(); sendInput(btn.dataset.seq); });
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
```

- [ ] **Step 5: Append to `public/styles.css`** — controls, search bar, mobile keys.

```css
/* SP3 terminal controls */
.term-header .spacer { flex: 1; }
.ctl { font:inherit; font-size:13px; padding:4px 9px; border-radius:7px; border:1px solid #2a3445;
  background:transparent; color:var(--text); cursor:pointer; }
.ctl:hover { border-color:var(--accent); color:var(--accent); }
#search-bar { display:flex; gap:6px; align-items:center; padding:8px 16px; background:#0f1623; border-bottom:1px solid #1f2937; }
#search-input { flex:0 0 240px; font:inherit; font-size:13px; padding:6px 10px; border-radius:7px;
  border:1px solid #2a3445; background:#0b0f17; color:var(--text); }
#mobile-keys { display:none; gap:6px; padding:8px; background:#0f1623; border-top:1px solid #1f2937;
  overflow-x:auto; }
#mobile-keys button { flex:0 0 auto; font:inherit; font-size:14px; min-width:44px; padding:10px 12px;
  border-radius:8px; border:1px solid #2a3445; background:#151b27; color:var(--text); }
#mobile-keys button:active { background:var(--accent); color:#fff; }
@media (max-width: 820px) { #mobile-keys { display:flex; } }
```

- [ ] **Step 6: Verify** — syntax + vendored assets + no test regressions.

```bash
node --check public/terminal.js && echo "terminal.js OK"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --input-type=module -e "
import { createServer } from './src/server.js'; import { loadTiles } from './src/config.js';
const { server, close } = createServer({ tiles: loadTiles('./config.json'), verifier: async()=>({email:'d@x'}), audit:{event(){},command(){}}, fallbackDir: process.cwd(), idleMinutes:60 });
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port,h={'cf-access-jwt-assertion':'d@x'};
for (const f of ['/terminal','/vendor/addon-web-links.js','/vendor/addon-search.js','/terminal.js?v=5']) { const r=await fetch('http://127.0.0.1:'+p+f,{headers:h}); console.log(f, r.status); }
await close();
"
```
Expected: `terminal.js OK`; 41 pass / 0 fail; every asset `200`.

- [ ] **Step 7: Commit**

```bash
git add scripts/copy-vendor.js public/terminal.html public/terminal.js public/styles.css package.json package-lock.json
git commit -m "feat: terminal links, search, copy/paste, font/theme/fullscreen, mobile keys"
```

---

### Task 2: Dashboard search + grouping

**Files:**
- Modify: `src/config.js`, `test/config.test.js`, `public/index.html`, `public/dashboard.js`, `public/styles.css`

**Interfaces:** Consumes `/api/tiles` (now may include `group`).

- [ ] **Step 1: `src/config.js`** — pass through optional `group`. After the `shell` passthrough line add:

```javascript
    if (typeof t.group === 'string' && t.group) tile.group = t.group;
```

- [ ] **Step 2: `test/config.test.js`** — add before cleanup test:

```javascript
test('passes through optional group', () => {
  const p = tmpConfig({ tiles: [{ path: 'C:\\a', group: 'Work' }, { path: 'C:\\b' }] });
  const tiles = loadTiles(p);
  assert.equal(tiles[0].group, 'Work');
  assert.ok(!('group' in tiles[1]));
});
```
Run `node --test test/config.test.js` → pass.

- [ ] **Step 3: `public/index.html`** — add a search input; bump `?v=5`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>access · clydeford</title>
  <link rel="stylesheet" href="/styles.css?v=5" />
</head>
<body>
  <header>
    <h1>⌘ CMD Access</h1>
    <input id="tile-search" type="text" placeholder="search tiles…" />
    <span class="who" id="who"></span>
  </header>
  <main id="grid-root"></main>
  <script src="/dashboard.js?v=5"></script>
</body>
</html>
```

- [ ] **Step 4: Rewrite `public/dashboard.js`** — filter + grouping (safe DOM, no innerHTML for tile data).

```javascript
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
```

- [ ] **Step 5: Append to `public/styles.css`** — search input + group headings.

```css
/* SP3 dashboard */
header #tile-search { flex:0 0 280px; font:inherit; font-size:14px; padding:8px 12px; border-radius:9px;
  border:1px solid #2a3445; background:#0b0f17; color:var(--text); }
.group-heading { padding:8px 32px 0; margin:18px 0 0; font-size:14px; text-transform:uppercase;
  letter-spacing:.08em; color:var(--muted); }
.empty { padding:32px; color:var(--muted); }
```

- [ ] **Step 6: Verify**

```bash
node --check public/dashboard.js && echo "dashboard.js OK"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --input-type=module -e "
import { createServer } from './src/server.js'; import { loadTiles } from './src/config.js';
const { server, close } = createServer({ tiles: loadTiles('./config.json'), verifier: async()=>({email:'d@x'}), audit:{event(){},command(){}}, fallbackDir: process.cwd(), idleMinutes:60 });
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port,h={'cf-access-jwt-assertion':'d@x'};
const html=await (await fetch('http://127.0.0.1:'+p+'/',{headers:h})).text();
console.log('index has tile-search + ?v=5:', html.includes('tile-search') && html.includes('/dashboard.js?v=5'));
await close();
"
```
Expected: `dashboard.js OK`; 42 pass / 0 fail; index check `true`.

- [ ] **Step 7: Commit**

```bash
git add src/config.js test/config.test.js public/index.html public/dashboard.js public/styles.css
git commit -m "feat: dashboard tile search + grouping (config group field)"
```

---

## Self-Review

- Links/search/copy-paste/font/theme/fullscreen/mobile-keys → Task 1 ✓
- Dashboard search + grouping + `group` config → Task 2 ✓
- SP1 reconnect/status/idle preserved verbatim in the new terminal.js → Task 1 Step 4 ✓
- SP2 CSP unaffected (addons `'self'`, clipboard needs no grant) ✓
- Safe DOM (textContent) retained in dashboard tiles + modal → Task 2 ✓
- `?v=5` bump both pages ✓
- Placeholders: none. Globals verified in Step 2 before use. Types: `setFont(n)`, `render(query)`, `makeTile(t)`, `showIntro(tile,onOk)` consistent.

**Deploy:** assets are served fresh (`?v=5`); `config.js` `group` passthrough is server-side → restart `AccessCmdTerminal` (elevated) so `/api/tiles` includes `group` and to be safe.
