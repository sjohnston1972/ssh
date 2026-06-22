# SP4 — File Transfer + Audit Viewer + Log Rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Browser upload/download to a tile's folder, an audit-log viewer page, and audit-log rotation — all behind auth + per-tile authorization + path containment.

**Architecture:** Pure helpers (`src/files.js`, additions to `src/audit.js`) do authorization-aware path resolution and log reading/pruning. `src/server.js` adds `/api/files|upload|download|audit` routes and serves `/audit`, each re-checking the tile authorization from SP2. New client UI: a files panel on the terminal page and an `audit.html` viewer.

**Tech Stack:** Node v24 (ESM), `node:test`. No new dependencies (raw-body PUT upload, no multipart lib).

## Global Constraints

- ESM; `node --test test/*.test.js`; keep all prior tests green.
- Identity = JWT `email` (fallback `sub`).
- Every file endpoint: resolve the `path` param to a **configured + allowed** tile via `resolveTileDir` (else 403); constrain file name with `safeChildPath` (basename + containment; else 400/404). Never accept arbitrary filesystem paths.
- Upload cap default **100 MB** (`maxUploadBytes`), oversize ⇒ 413, no partial file.
- Audit retention default **30 days** (`AUDIT_RETENTION_DAYS`); prune runs at startup.
- `/api/audit` available to any authenticated user (both are admins); newest-first; default limit 500.
- Assets bump to `?v=6` where changed.
- Reuse SP2 `tileAllowed`; reuse `securityHeaders` (already applied globally to HTTP responses).

---

### Task 1: Pure helpers — files.js + audit.js (prune/read)

**Files:**
- Create: `src/files.js`, `test/files.test.js`
- Modify: `src/audit.js`, `test/audit.test.js`

**Interfaces:**
- Produces: `resolveTileDir(tiles, path, email) => string|null`, `safeChildPath(dir, name) => string|null`; `pruneOldLogs(dir, retentionDays) => void`, `readRecentAudit(dir, limit) => object[]`.

- [ ] **Step 1: Write `test/files.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTileDir, safeChildPath } from '../src/files.js';

const tiles = [
  { label: 'Open', path: 'C:\\open' },
  { label: 'Boss', path: 'C:\\boss', allow: ['boss@x'] },
];

test('resolveTileDir returns dir for configured+allowed tile', () => {
  assert.equal(resolveTileDir(tiles, 'C:\\open', 'anyone@x'), 'C:\\open');
  assert.equal(resolveTileDir(tiles, 'C:\\boss', 'boss@x'), 'C:\\boss');
});
test('resolveTileDir null for unknown path or disallowed identity', () => {
  assert.equal(resolveTileDir(tiles, 'C:\\nope', 'a@x'), null);
  assert.equal(resolveTileDir(tiles, 'C:\\boss', 'peon@x'), null);
});
test('safeChildPath keeps inside dir, strips traversal', () => {
  assert.equal(safeChildPath('C:\\d', 'file.txt'), require('node:path').resolve('C:\\d', 'file.txt'));
  assert.equal(safeChildPath('C:\\d', '..\\..\\evil'), require('node:path').resolve('C:\\d', 'evil'));
  assert.equal(safeChildPath('C:\\d', 'a/b/c.txt'), require('node:path').resolve('C:\\d', 'c.txt'));
  assert.equal(safeChildPath('C:\\d', '..'), null);
  assert.equal(safeChildPath('C:\\d', ''), null);
});
```

> Note: `require` is available in `node --test` even under ESM via `createRequire`-free CommonJS interop in test files? It is NOT. Replace the three `require('node:path').resolve` calls with an `import { resolve } from 'node:path'` at the top and use `resolve(...)`. (Author the test with the import; the inline `require` above is shorthand — use the import form.)

Corrected top of file:
```javascript
import { resolve } from 'node:path';
```
and use `resolve('C:\\d', 'file.txt')` etc.

- [ ] **Step 2: Run, expect fail** — `node --test test/files.test.js`.

- [ ] **Step 3: Implement `src/files.js`**

```javascript
import { resolve, relative, basename } from 'node:path';
import { tileAllowed } from './authz.js';

export function resolveTileDir(tiles, path, email) {
  const tile = tiles.find((t) => t.path === path);
  if (!tile || !tileAllowed(tile, email)) return null;
  return tile.path;
}

export function safeChildPath(dir, name) {
  const base = basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  const target = resolve(dir, base);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) return null;
  return target;
}
```

- [ ] **Step 4: Run, expect pass** — `node --test test/files.test.js` → 3 pass.

- [ ] **Step 5: Extend `src/audit.js`** — append (keep `createAuditLogger` as-is). Ensure the imports at the top include the needed fns:

```javascript
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
```
(Adjust the existing import line to include `readdirSync, readFileSync, rmSync, existsSync` alongside the current `appendFileSync, mkdirSync`.)

Append:
```javascript
const AUDIT_RE = /^audit-\d{4}-\d{2}-\d{2}\.log$/;

export function pruneOldLogs(dir, retentionDays = 30) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const f of readdirSync(dir)) {
    const m = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (!m) continue;
    const t = Date.parse(m[1] + 'T00:00:00Z');
    if (!Number.isNaN(t) && t < cutoff) { try { rmSync(join(dir, f)); } catch {} }
  }
}

export function readRecentAudit(dir, limit = 500) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => AUDIT_RE.test(f)).sort().reverse();
  const out = [];
  for (const f of files) {
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim(); if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
      if (out.length >= limit) return out;
    }
  }
  return out;
}
```

- [ ] **Step 6: Extend `test/audit.test.js`** — add (the file already imports `createAuditLogger`; add the new imports + temp-dir helper usage):

```javascript
import { pruneOldLogs, readRecentAudit } from '../src/audit.js';
import { writeFileSync as wf, mkdtempSync as mt, readdirSync as rd } from 'node:fs';
import { tmpdir as td } from 'node:os';
import { join as jn } from 'node:path';

test('pruneOldLogs deletes only files older than retention', () => {
  const dir = mt(jn(td(), 'aud-'));
  wf(jn(dir, 'audit-2000-01-01.log'), 'x\n');
  const today = new Date().toISOString().slice(0, 10);
  wf(jn(dir, `audit-${today}.log`), 'y\n');
  wf(jn(dir, 'notes.txt'), 'keep\n');
  pruneOldLogs(dir, 30);
  const left = rd(dir);
  assert.ok(!left.includes('audit-2000-01-01.log'));
  assert.ok(left.includes(`audit-${today}.log`));
  assert.ok(left.includes('notes.txt'));
});

test('readRecentAudit returns newest-first and tolerates malformed lines', () => {
  const dir = mt(jn(td(), 'aud2-'));
  wf(jn(dir, 'audit-2024-01-01.log'), JSON.stringify({ ts: 'a', type: 'one' }) + '\nNOT JSON\n' + JSON.stringify({ ts: 'b', type: 'two' }) + '\n');
  const rows = readRecentAudit(dir, 10);
  assert.equal(rows[0].type, 'two');   // newest (last line) first
  assert.equal(rows[1].type, 'one');
  assert.equal(rows.length, 2);        // malformed skipped
});
```

- [ ] **Step 7: Full suite** — `npm test` → all pass (42 + 3 files + 2 audit = 47).

- [ ] **Step 8: Commit**

```bash
git add src/files.js test/files.test.js src/audit.js test/audit.test.js
git commit -m "feat: file-path authz helpers + audit prune/read"
```

---

### Task 2: Server endpoints + startup prune

**Files:**
- Modify: `src/server.js`, `test/server.test.js`

**Interfaces:** Consumes `resolveTileDir`/`safeChildPath` (Task 1), `readRecentAudit`/`pruneOldLogs` (Task 1).

- [ ] **Step 1: Extend `test/server.test.js`** — add (helpers `start`/`connect` already exist; `start` must now accept a `logsDir`/`maxUploadBytes` via `opts.server`):

```javascript
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('file upload → list → download round-trip for an allowed tile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tile-'));
  const tiles = [{ label: 'F', path: dir, icon: '📁' }];
  const { port, close } = await start({ tiles });
  const h = { 'cf-access-jwt-assertion': 'a@x' };
  // upload
  const up = await fetch(`http://127.0.0.1:${port}/api/upload?path=${encodeURIComponent(dir)}&name=hello.txt`, { method: 'PUT', headers: h, body: 'HELLO-SP4' });
  assert.equal(up.status, 200);
  assert.ok(existsSync(join(dir, 'hello.txt')));
  // list
  const list = await (await fetch(`http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(dir)}`, { headers: h })).json();
  assert.ok(list.find((e) => e.name === 'hello.txt'));
  // download
  const dl = await fetch(`http://127.0.0.1:${port}/api/download?path=${encodeURIComponent(dir)}&file=hello.txt`, { headers: h });
  assert.equal(await dl.text(), 'HELLO-SP4');
  await close();
});

test('upload to a disallowed tile is 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tile2-'));
  const tiles = [{ label: 'Boss', path: dir, icon: '🔒', allow: ['boss@x'] }];
  const { port, close } = await start({ tiles });
  const up = await fetch(`http://127.0.0.1:${port}/api/upload?path=${encodeURIComponent(dir)}&name=x.txt`, { method: 'PUT', headers: { 'cf-access-jwt-assertion': 'peon@x' }, body: 'no' });
  assert.equal(up.status, 403);
  assert.ok(!existsSync(join(dir, 'x.txt')));
  await close();
});

test('download with traversal name is contained (not found)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tile3-'));
  const tiles = [{ label: 'F', path: dir, icon: '📁' }];
  const { port, close } = await start({ tiles });
  const r = await fetch(`http://127.0.0.1:${port}/api/download?path=${encodeURIComponent(dir)}&file=${encodeURIComponent('..\\\\..\\\\secret')}`, { headers: { 'cf-access-jwt-assertion': 'a@x' } });
  assert.ok(r.status === 404 || r.status === 400);
  await close();
});

test('/api/audit returns a JSON array', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'logs-'));
  writeFileSync(join(logsDir, 'audit-2024-01-01.log'), JSON.stringify({ ts: 'a', type: 'session_start', email: 'a@x' }) + '\n');
  const { port, close } = await start({ server: { logsDir } });
  const rows = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { 'cf-access-jwt-assertion': 'a@x' } })).json();
  assert.ok(Array.isArray(rows) && rows[0].type === 'session_start');
  await close();
});

test('oversize upload is rejected (413)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tile4-'));
  const tiles = [{ label: 'F', path: dir, icon: '📁' }];
  const { port, close } = await start({ tiles, server: { maxUploadBytes: 8 } });
  const up = await fetch(`http://127.0.0.1:${port}/api/upload?path=${encodeURIComponent(dir)}&name=big.txt`, { method: 'PUT', headers: { 'cf-access-jwt-assertion': 'a@x' }, body: 'way too long body' });
  assert.equal(up.status, 413);
  await close();
});
```

Also update the `start` helper's `createServer` call to forward `logsDir` and `maxUploadBytes` from `opts.server` (the `...opts.server` spread already does this — just ensure `createServer` accepts them, see Step 2).

- [ ] **Step 2: Run, expect fail** — `node --test test/server.test.js`.

- [ ] **Step 3: Modify `src/server.js`**

1. Imports — extend the `node:fs` and `node:path` imports and add the new modules:
```javascript
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, createReadStream } from 'node:fs';
import { join, extname, dirname, resolve, relative, basename } from 'node:path';
import { resolveTileDir, safeChildPath } from './files.js';
import { readRecentAudit, pruneOldLogs } from './audit.js';
```
(Merge with existing imports — don't duplicate `loadTiles`, etc. Note `visibleTiles, tileAllowed` from `./authz.js` already imported.)

2. Signature — add `logsDir` and `maxUploadBytes`:
```javascript
export function createServer({ tiles, verifier, audit, fallbackDir, idleMinutes, graceMinutes = 10, bufferBytes = 262144, logsDir = join(ROOT, 'logs'), maxUploadBytes = 100 * 1024 * 1024 }) {
```

3. In the HTTP request handler, after `securityHeaders(res);`, resolve identity once and add the routes BEFORE the final 404:
```javascript
    securityHeaders(res);
    const identity = payload.email || payload.sub || 'unknown';
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/' ) return serveStatic(res, 'index.html');
    if (url.pathname === '/terminal') return serveStatic(res, 'terminal.html');
    if (url.pathname === '/audit') return serveStatic(res, 'audit.html');
    if (url.pathname === '/api/tiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(visibleTiles(tiles, identity)));
    }
    if (url.pathname === '/api/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ email: identity }));
    }
    if (url.pathname === '/api/audit') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(readRecentAudit(logsDir, Number(url.searchParams.get('limit')) || 500)));
    }
    if (url.pathname === '/api/files') {
      const dir = resolveTileDir(tiles, url.searchParams.get('path'), identity);
      if (!dir) { res.writeHead(403); return res.end('forbidden'); }
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((d) => {
          let size = 0, mtime = 0; try { const st = statSync(join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
          return { name: d.name, size, isDir: d.isDirectory(), mtime };
        });
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(entries));
    }
    if (url.pathname === '/api/download') {
      const dir = resolveTileDir(tiles, url.searchParams.get('path'), identity);
      if (!dir) { res.writeHead(403); return res.end('forbidden'); }
      const target = safeChildPath(dir, url.searchParams.get('file'));
      if (!target || !existsSync(target) || statSync(target).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${basename(target)}"` });
      audit.event('file_download', { email: identity, path: dir, name: basename(target) });
      return createReadStream(target).pipe(res);
    }
    if (url.pathname === '/api/upload' && req.method === 'PUT') {
      const dir = resolveTileDir(tiles, url.searchParams.get('path'), identity);
      if (!dir) { res.writeHead(403); return res.end('forbidden'); }
      const target = safeChildPath(dir, url.searchParams.get('name'));
      if (!target) { res.writeHead(400); return res.end('bad name'); }
      const chunks = []; let size = 0; let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        size += c.length;
        if (size > maxUploadBytes) { aborted = true; res.writeHead(413); res.end('too large'); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          writeFileSync(target, Buffer.concat(chunks));
          audit.event('file_upload', { email: identity, path: dir, name: basename(target), size });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: basename(target), size }));
        } catch { res.writeHead(500); res.end('write failed'); }
      });
      return;
    }
    if (url.pathname.startsWith('/vendor/')) return serveStatic(res, url.pathname.slice(1));
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
      return serveStatic(res, url.pathname.replace(/^\//, ''));
    res.writeHead(404); res.end('not found');
```
(Remove the old duplicate declarations of `url`/the early routes that this block replaces — there must be exactly one `const url = ...` and one of each route.)

4. Entrypoint — prune at startup and pass `logsDir`:
```javascript
  const logsDir = join(ROOT, 'logs');
  const audit = createAuditLogger(logsDir);
  pruneOldLogs(logsDir, Number(env.AUDIT_RETENTION_DAYS || 30));
  ...
  const { server } = createServer({
    tiles, verifier, audit, fallbackDir: env.FALLBACK_DIR,
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 15),
    graceMinutes: Number(env.SESSION_GRACE_MINUTES || 10),
    bufferBytes: Number(env.SESSION_BUFFER_BYTES || 262144),
    logsDir,
  });
```

- [ ] **Step 4: Run, expect pass** — `node --test test/server.test.js` → all pass.

- [ ] **Step 5: Full suite** — `npm test` → 0 failures (47 + 5 server = 52).

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: file upload/download/list + audit API endpoints; prune logs at startup"
```

---

### Task 3: Client — files panel + audit viewer

**Files:**
- Modify: `public/terminal.html`, `public/terminal.js`, `public/styles.css` (bump `?v=6`)
- Create: `public/audit.html`, `public/audit.js`

**Interfaces:** Consumes `/api/files|upload|download` (scoped to current `tilePath`) and `/api/audit`.

- [ ] **Step 1: `public/terminal.html`** — bump `?v=6` on styles.css + terminal.js; add a Files button in the header (after `btn-fullscreen`) and a files panel before `#terminal-host`:

```html
    <button id="btn-files" class="ctl" title="Files">📁</button>
```
```html
  <div id="files-panel" hidden>
    <div class="files-head">
      <strong>Files</strong>
      <label class="ctl" style="cursor:pointer">⬆ Upload<input id="file-input" type="file" multiple hidden /></label>
      <button id="files-refresh" class="ctl">↻</button>
      <button id="files-close" class="ctl">✕</button>
    </div>
    <ul id="files-list"></ul>
  </div>
```
(Place `#files-panel` right after the `#search-bar` div. Bump both `?v=5` → `?v=6`.)

- [ ] **Step 2: Append to `public/terminal.js`** — files panel logic (does not touch the existing SP1/SP3 code; append at the end):

```javascript
// --- SP4: files panel ---
const filesPanel = document.getElementById('files-panel');
const filesList = document.getElementById('files-list');
const fileInput = document.getElementById('file-input');
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }
async function loadFiles() {
  filesList.textContent = '';
  let entries = [];
  try { entries = await (await fetch('/api/files?path=' + encodeURIComponent(tilePath))).json(); } catch {}
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const e of entries) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'fname'; name.textContent = (e.isDir ? '📂 ' : '📄 ') + e.name;
    li.appendChild(name);
    if (!e.isDir) {
      const meta = document.createElement('span'); meta.className = 'fmeta'; meta.textContent = fmtSize(e.size);
      const dl = document.createElement('a'); dl.className = 'ctl'; dl.textContent = '⬇';
      dl.href = '/api/download?path=' + encodeURIComponent(tilePath) + '&file=' + encodeURIComponent(e.name);
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
    try { await fetch('/api/upload?path=' + encodeURIComponent(tilePath) + '&name=' + encodeURIComponent(f.name), { method: 'PUT', body: f }); } catch {}
  }
  fileInput.value = '';
  loadFiles();
};
```

- [ ] **Step 3: Append to `public/styles.css`** — files panel styles:

```css
/* SP4 files panel */
#files-panel { background:#0f1623; border-bottom:1px solid #1f2937; max-height:40vh; overflow:auto; }
.files-head { display:flex; gap:10px; align-items:center; padding:10px 16px; }
#files-list { list-style:none; margin:0; padding:0 16px 12px; }
#files-list li { display:flex; align-items:center; gap:12px; padding:6px 0; border-top:1px solid #18202e; }
#files-list .fname { flex:1; font-family:Consolas,monospace; font-size:13px; }
#files-list .fmeta { color:var(--muted); font-size:12px; }
#files-list a.ctl { text-decoration:none; }
#files-list .empty { color:var(--muted); }
```

- [ ] **Step 4: Create `public/audit.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>audit · clydeford</title>
  <link rel="stylesheet" href="/styles.css?v=6" />
</head>
<body>
  <header>
    <h1>⌘ Audit Log</h1>
    <button id="refresh" class="ctl">↻ Refresh</button>
    <a class="who" href="/">← tiles</a>
  </header>
  <main>
    <table id="audit-table"><thead><tr><th>Time</th><th>Type</th><th>User</th><th>Detail</th></tr></thead><tbody></tbody></table>
  </main>
  <script src="/audit.js?v=6"></script>
</body>
</html>
```

- [ ] **Step 5: Create `public/audit.js`** (safe DOM, no innerHTML for data)

```javascript
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
```

- [ ] **Step 6: Append audit table styles to `public/styles.css`**

```css
/* SP4 audit table */
#audit-table { width:100%; border-collapse:collapse; font-size:13px; }
#audit-table th, #audit-table td { text-align:left; padding:8px 12px; border-bottom:1px solid #1f2937; vertical-align:top; }
#audit-table th { color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:.06em; }
#audit-table td:nth-child(4) { font-family:Consolas,monospace; word-break:break-all; }
main { padding:16px 24px; }
```

- [ ] **Step 7: Verify** — syntax + assets + tests.

```bash
node --check public/terminal.js && node --check public/audit.js && echo OK
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --input-type=module -e "
import { createServer } from './src/server.js'; import { loadTiles } from './src/config.js';
const { server, close } = createServer({ tiles: loadTiles('./config.json'), verifier: async()=>({email:'d@x'}), audit:{event(){},command(){}}, fallbackDir: process.cwd(), idleMinutes:60 });
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port,h={'cf-access-jwt-assertion':'d@x'};
for (const f of ['/audit','/audit.js?v=6','/terminal.js?v=6','/api/audit']) { const r=await fetch('http://127.0.0.1:'+p+f,{headers:h}); console.log(f, r.status); }
await close();
"
```
Expected: `OK`; 52 pass / 0 fail; every route `200`.

- [ ] **Step 8: Commit**

```bash
git add public/terminal.html public/terminal.js public/styles.css public/audit.html public/audit.js
git commit -m "feat: terminal files panel + audit viewer page"
```

---

## Self-Review

- File endpoints with auth + tile-authz + containment → Task 2 (routes) using Task 1 helpers ✓
- Upload size cap (413) → Task 2 ✓; round-trip + traversal + disallowed tests → Task 2 ✓
- Audit API + viewer page → Tasks 2 + 3 ✓
- Log rotation at startup → Task 2 entrypoint + Task 1 `pruneOldLogs` (tested) ✓
- Safe DOM (textContent) in files list + audit table ✓
- No new deps; CSP unaffected (same-origin fetch/links; downloads are same-origin) ✓
- `?v=6` bump ✓
- Placeholders: none (the `require`→`import` correction in Task 1 Step 1 is called out explicitly). Types consistent: `resolveTileDir(tiles,path,email)`, `safeChildPath(dir,name)`, `readRecentAudit(dir,limit)`, `pruneOldLogs(dir,days)`.

**Deploy:** server-side endpoints + entrypoint prune → restart `AccessCmdTerminal` (elevated) after build+review; client assets `?v=6` served fresh.
