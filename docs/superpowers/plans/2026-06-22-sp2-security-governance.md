# SP2 — Security / Governance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restrict which tiles each identity may see and launch (per-tile `allow` list), enforced on `/api/tiles` and WS `start`, plus add CSP/security headers.

**Architecture:** A tiny pure `src/authz.js` (`tileAllowed`/`visibleTiles`) is used by `server.js` to filter `/api/tiles` and to reject unauthorized/unknown `start` requests. A `securityHeaders` helper sets CSP and related headers on every response. `config.js` validates+passes through the optional `allow` array.

**Tech Stack:** Node.js v24 (ESM), `node:test`. No new deps.

## Global Constraints

- ESM; tests `node --test test/*.test.js`; keep existing 31 tests green.
- Identity = JWT `email` (fallback `sub`).
- `allow` absent/empty ⇒ tile visible to all who pass Access; present ⇒ only listed emails (case-insensitive).
- Only **configured** tiles may be launched: a WS `start` for an unknown or disallowed `tilePath` is rejected (`error` message, no spawn) and audited `start_denied{email,path}`.
- CSP exactly: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`. Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Do not break SP1: `manager.start` is only called for authorized configured tiles.

---

### Task 1: authz module + config `allow` passthrough

**Files:**
- Create: `src/authz.js`, `test/authz.test.js`
- Modify: `src/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `tileAllowed(tile, email) => boolean`, `visibleTiles(tiles, email) => tile[]`.

- [ ] **Step 1: Write failing tests** — `test/authz.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileAllowed, visibleTiles } from '../src/authz.js';

test('no allow list ⇒ allowed for anyone', () => {
  assert.equal(tileAllowed({ path: 'C:\\x' }, 'a@x'), true);
  assert.equal(tileAllowed({ path: 'C:\\x', allow: [] }, 'a@x'), true);
});
test('allow list restricts by email (case-insensitive)', () => {
  const t = { path: 'C:\\x', allow: ['Owner@X.com'] };
  assert.equal(tileAllowed(t, 'owner@x.com'), true);
  assert.equal(tileAllowed(t, 'other@x'), false);
});
test('undefined tile ⇒ not allowed', () => {
  assert.equal(tileAllowed(undefined, 'a@x'), false);
});
test('visibleTiles filters per identity', () => {
  const tiles = [{ path: 'a' }, { path: 'b', allow: ['boss@x'] }];
  assert.deepEqual(visibleTiles(tiles, 'boss@x').map((t) => t.path), ['a', 'b']);
  assert.deepEqual(visibleTiles(tiles, 'nobody@x').map((t) => t.path), ['a']);
});
```

- [ ] **Step 2: Run, expect fail** — `node --test test/authz.test.js` → cannot find module.

- [ ] **Step 3: Implement `src/authz.js`**

```javascript
export function tileAllowed(tile, email) {
  if (!tile) return false;
  if (!Array.isArray(tile.allow) || tile.allow.length === 0) return true;
  const e = String(email || '').toLowerCase();
  return tile.allow.some((a) => String(a).toLowerCase() === e);
}

export function visibleTiles(tiles, email) {
  return tiles.filter((t) => tileAllowed(t, email));
}
```

- [ ] **Step 4: Run, expect pass** — `node --test test/authz.test.js` → 4 pass.

- [ ] **Step 5: Extend `src/config.js`** — validate + pass through `allow`. After the existing `shell`/`intro` passthrough lines in the `.map`, add:

```javascript
    if (t.allow !== undefined) {
      if (!Array.isArray(t.allow) || t.allow.some((a) => typeof a !== 'string')) {
        throw new Error(`config: tile ${i} allow must be an array of strings`);
      }
      tile.allow = t.allow;
    }
```

- [ ] **Step 6: Extend `test/config.test.js`** — add before the cleanup test:

```javascript
test('passes through allow array and rejects malformed allow', () => {
  const p = tmpConfig({ tiles: [{ path: 'C:\\a', allow: ['x@y'] }] });
  assert.deepEqual(loadTiles(p)[0].allow, ['x@y']);
  const bad = tmpConfig({ tiles: [{ path: 'C:\\a', allow: 'nope' }] });
  assert.throws(() => loadTiles(bad), /allow must be an array/);
});
```

- [ ] **Step 7: Full suite** — `npm test` → all pass (31 + 4 authz + 1 config = 36).

- [ ] **Step 8: Commit**

```bash
git add src/authz.js test/authz.test.js src/config.js test/config.test.js
git commit -m "feat: per-tile authorization (allow lists) + config validation"
```

---

### Task 2: Enforce authz in server + security headers

**Files:**
- Modify: `src/server.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `visibleTiles`, `tileAllowed` (Task 1).

- [ ] **Step 1: Extend integration tests** — `test/server.test.js`. Add these tests (the `start`/`connect`/`collect` helpers already exist from SP1):

```javascript
import { tileAllowed } from '../src/authz.js';   // add near top imports (used indirectly; keeps import graph honest)

test('/api/tiles is filtered per identity', async () => {
  const tiles = [{ label: 'Open', path: 'C:\\open', icon: '📁' },
                 { label: 'Boss', path: 'C:\\boss', icon: '🔒', allow: ['boss@x'] }];
  const { port, close } = await start({ tiles });
  const boss = await (await fetch(`http://127.0.0.1:${port}/api/tiles`, { headers: { 'cf-access-jwt-assertion': 'boss@x' } })).json();
  const peon = await (await fetch(`http://127.0.0.1:${port}/api/tiles`, { headers: { 'cf-access-jwt-assertion': 'peon@x' } })).json();
  assert.deepEqual(boss.map((t) => t.path), ['C:\\open', 'C:\\boss']);
  assert.deepEqual(peon.map((t) => t.path), ['C:\\open']);
  await close();
});

test('WS start on a disallowed tile is rejected with error, no session', async () => {
  const tiles = [{ label: 'Boss', path: process.cwd(), icon: '🔒', allow: ['boss@x'] }];
  const { port, close } = await start({ tiles });
  const ws = connect(port, 'peon@x');
  const got = await new Promise((resolve) => {
    let sawData = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', tilePath: process.cwd() })));
    ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.type === 'data') sawData = true; if (msg.type === 'error') resolve({ error: msg.message, sawData }); });
    setTimeout(() => resolve({ error: null, sawData }), 2000);
  });
  ws.close();
  assert.match(got.error || '', /not authorized/i);
  assert.equal(got.sawData, false);
  await close();
});

test('security headers present on responses', async () => {
  const { port, close } = await start();
  const r = await fetch(`http://127.0.0.1:${port}/api/tiles`, { headers: { 'cf-access-jwt-assertion': 'x' } });
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  await close();
});
```

- [ ] **Step 2: Run, expect fail** — `node --test test/server.test.js` (filtering/headers/denial not implemented).

- [ ] **Step 3: Modify `src/server.js`**

1. Add import:
```javascript
import { visibleTiles, tileAllowed } from './authz.js';
```

2. Add a headers helper and apply it. Inside `createServer`, define:
```javascript
  function securityHeaders(res) {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
  }
```
Call `securityHeaders(res);` at the top of the HTTP request handler immediately after the `authed` try/catch succeeds (so it applies to `/`, `/terminal`, `/api/*`, static). (Headers set via `setHeader` before `writeHead` are preserved.)

3. Filter `/api/tiles`:
```javascript
    if (url.pathname === '/api/tiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(visibleTiles(tiles, payload.email || payload.sub || 'unknown')));
    }
```

4. Enforce on WS `start` in `onConnect`. Replace the `start` branch body with:
```javascript
      if (msg.type === 'start') {
        const tile = tiles.find((t) => t.path === msg.tilePath);
        if (!tile || !tileAllowed(tile, identity)) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'Not authorized for this tile' })); } catch {}
          audit.event('start_denied', { email: identity, path: msg.tilePath });
          return;
        }
        manager.start(identity, ws, {
          tilePath: msg.tilePath, cols: msg.cols, rows: msg.rows,
          shell: tile.shell, command: tile.command,
        });
      } else if (msg.type === 'input') {
```

(Leave `input`/`resize`/heartbeat/etc. unchanged.)

- [ ] **Step 4: Run, expect pass** — `node --test test/server.test.js` → all pass.

- [ ] **Step 5: Full suite + CSP-doesn't-break-terminal serve check**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` (0 fail), then:
```bash
node --input-type=module -e "
import { createServer } from './src/server.js';
import { loadTiles } from './src/config.js';
const { server, close } = createServer({ tiles: loadTiles('./config.json'), verifier: async()=>({email:'d@x'}), audit:{event(){},command(){}}, fallbackDir: process.cwd(), idleMinutes:60 });
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port,h={'cf-access-jwt-assertion':'d@x'};
const t=await (await fetch('http://127.0.0.1:'+p+'/terminal',{headers:h}));
console.log('CSP on /terminal:', /default-src/.test(t.headers.get('content-security-policy')||''));
console.log('terminal.js loads (self):', (await (await fetch('http://127.0.0.1:'+p+'/terminal.js?v=4',{headers:h})).text()).length>0);
await close();
"
```
Expected: both true.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: enforce per-tile authz on /api/tiles + WS start; add CSP/security headers"
```

---

## Self-Review

- Per-identity visibility (`/api/tiles`) → Task 2 ✓
- WS launch authorization + unknown-tile rejection + `start_denied` audit → Task 2 ✓
- `allow` config passthrough + validation → Task 1 ✓
- CSP + headers (exact string, applied to all responses, doesn't break xterm) → Task 2 (helper + serve check) ✓
- Pure authz unit-tested; integration covers filtering, denial, headers ✓
- Keeps SP1 green (only the `start` branch gains a guard before `manager.start`) ✓
- Placeholders: none. Types consistent (`tileAllowed(tile,email)`, `visibleTiles(tiles,email)`).

**Deploy:** server-side change → restart `AccessCmdTerminal` (elevated) after build+review.
