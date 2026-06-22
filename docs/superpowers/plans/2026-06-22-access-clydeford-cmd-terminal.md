# access.clydeford.net — Browser CMD Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js app on this Windows host that serves a dashboard of directory "tiles" and a full interactive `cmd.exe` terminal in the browser, reachable at `access.clydeford.net` behind Cloudflare Access MFA via the existing home-docker tunnel.

**Architecture:** A single Node.js process (port 7900, bind `0.0.0.0`) serves static UI over HTTP and a terminal stream over WebSocket. Each WS connection spawns one `cmd.exe` via `node-pty`, started in the selected tile's directory. Every HTTP request and WS upgrade is gated by verifying the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie). The home-docker tunnel routes `access.clydeford.net → http://host.docker.internal:7900`.

**Tech Stack:** Node.js v24, `ws` (8.x), `node-pty` (1.x) with prebuilt fallback, `jose` (6.x) for JWT, `@xterm/xterm` (6.x) + `@xterm/addon-fit` frontend, Node's built-in `node:test` runner, `node-windows` for the service. Cloudflare REST API for wiring.

## Global Constraints

- Platform: Windows 11, Node v24.15.0, npm 11.12.1. Shell under test is `cmd.exe`.
- App listens on `0.0.0.0:7900` (must be reachable from Docker via `host.docker.internal`).
- All requests/WS upgrades MUST pass JWT verification: issuer `https://clydeford.cloudflareaccess.com`, audience = the Access app's AUD tag.
- Tunnel to reuse: `home-docker` = `ac9da5b2-eaf1-4761-913a-0da854ced2e0`. Zone `clydeford.net` = `68c212a7f233ee505d871e816da19600`. Account = `5bdc4d7840e522355b86631e6b8fac2b`.
- Reusable Access policy "mfa" = `8b4b68fb-ed1b-4e29-90a3-0b11cf2dbc96` (already scoped to stevie.johnston@gmail.com + jrsgracey@gmail.com).
- Single active terminal session at a time (new connection takes over, old is closed).
- Audit log records session start/stop, JWT identity, and each command line.
- Secrets live in `.env` (never commit). API token already present there.
- ESM modules (`"type": "module"` in package.json). Use `node --test` for tests.
- Commit after each task. Repo is not yet a git repo — Task 1 runs `git init`.

---

## File Structure

```
C:\cloudflare_projects\ssh\
  package.json
  .env                      # existing; append PORT, ACCESS_* keys
  .gitignore
  config.json               # tile list (editable)
  src\
    config.js               # load + validate tiles
    auth.js                 # JWT verification
    pty-session.js          # cmd.exe via node-pty
    audit.js                # append-only audit logger
    server.js               # HTTP + WS server, session manager, entrypoint
  public\
    index.html              # dashboard
    dashboard.js
    terminal.html           # xterm terminal view
    terminal.js
    styles.css
    vendor\                 # copied xterm dist (gitignored, regenerated)
  scripts\
    wire-cloudflare.js      # create Access app, DNS, tunnel ingress
    firewall.ps1            # restrict inbound 7900
    install-service.js      # node-windows install
    uninstall-service.js
    copy-vendor.js          # copy xterm dist into public/vendor
  test\
    config.test.js
    auth.test.js
    pty-session.test.js
    server.test.js
  logs\                     # runtime audit logs (gitignored)
```

---

### Task 1: Project scaffolding + dependencies + node-pty verification

**Files:**
- Create: `package.json`, `.gitignore`, `config.json`, `scripts/copy-vendor.js`
- Modify: `.env` (append config keys)

**Interfaces:**
- Produces: installed `node_modules`; a verified-loadable `node-pty`; `public/vendor/` with xterm dist; npm scripts `start`, `test`, `vendor`.

- [ ] **Step 1: Initialize git and package.json**

```bash
cd /c/cloudflare_projects/ssh
git init
```

Create `package.json`:

```json
{
  "name": "access-cmd-terminal",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "vendor": "node scripts/copy-vendor.js",
    "start": "node src/server.js",
    "test": "node --test test/",
    "wire": "node scripts/wire-cloudflare.js"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
logs/
public/vendor/
.env
```

- [ ] **Step 3: Install dependencies**

```bash
npm install ws@^8 jose@^6 @xterm/xterm@^6 @xterm/addon-fit@^0.11
npm install node-pty@^1
```

- [ ] **Step 4: Verify node-pty actually loads (the key risk)**

Run:
```bash
node -e "import('node-pty').then(p=>{const t=p.spawn('cmd.exe',[],{cols:80,rows:24});t.kill();console.log('node-pty OK');}).catch(e=>{console.error('node-pty FAILED:',e.message);process.exit(1);})"
```
Expected: `node-pty OK`.

If it fails with a build/`MSBuild`/`cl.exe` error, install build tools then reinstall:
```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
npm rebuild node-pty
```
If build tools are unavailable, fall back to the prebuilt fork and use it everywhere `node-pty` is imported:
```bash
npm uninstall node-pty && npm install @homebridge/node-pty-prebuilt-multiarch
```
Re-run the verify line (swap the import specifier). Record which package succeeded; `src/pty-session.js` must import that same specifier.

- [ ] **Step 5: Create `config.json` with the seeded tile**

```json
{
  "tiles": [
    { "label": "Crucible", "path": "C:\\cloudflare_projects\\crucible", "icon": "🔥" }
  ]
}
```

- [ ] **Step 6: Create `scripts/copy-vendor.js`**

```javascript
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];
for (const [from, to] of files) {
  copyFileSync(join(root, 'node_modules', from), join(out, to));
  console.log('copied', to);
}
```

Run: `npm run vendor`
Expected: prints `copied xterm.js`, `copied xterm.css`, `copied addon-fit.js`. If a source path differs for the installed version, run `node -e "console.log(require.resolve('@xterm/xterm'))"` and adjust paths.

- [ ] **Step 7: Append config keys to `.env`**

Append (do NOT remove existing keys):
```
PORT=7900
BIND=0.0.0.0
ACCESS_TEAM_DOMAIN=clydeford.cloudflareaccess.com
ACCESS_AUD=
SESSION_IDLE_MINUTES=15
FALLBACK_DIR=C:\\Users\\steven
```
(`ACCESS_AUD` is filled in by Task 8.)

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold project, deps, vendor xterm, verify node-pty"
```

---

### Task 2: Tile config loader

**Files:**
- Create: `src/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `loadTiles(path: string) => Array<{label: string, path: string, icon: string}>`. Throws `Error` on malformed config or a tile missing `path`.

- [ ] **Step 1: Write the failing test** — `test/config.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTiles } from '../src/config.js';

function tmpConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('loads valid tiles and applies defaults', () => {
  const p = tmpConfig({ tiles: [{ path: 'C:\\a' }, { label: 'B', path: 'C:\\b', icon: '📁' }] });
  const tiles = loadTiles(p);
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].label, 'C:\\a');      // label defaults to path
  assert.equal(tiles[0].icon, '📁');           // icon defaults to 📁
  assert.equal(tiles[1].label, 'B');
});

test('throws when tiles is not an array', () => {
  const p = tmpConfig({ tiles: 'nope' });
  assert.throws(() => loadTiles(p), /tiles must be an array/);
});

test('throws when a tile is missing path', () => {
  const p = tmpConfig({ tiles: [{ label: 'no path' }] });
  assert.throws(() => loadTiles(p), /missing path/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find `../src/config.js`.

- [ ] **Step 3: Implement `src/config.js`**

```javascript
import { readFileSync } from 'node:fs';

export function loadTiles(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.tiles)) {
    throw new Error('config: tiles must be an array');
  }
  return raw.tiles.map((t, i) => {
    if (!t || typeof t.path !== 'string' || !t.path) {
      throw new Error(`config: tile ${i} missing path`);
    }
    return { label: t.label || t.path, path: t.path, icon: t.icon || '📁' };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js && git commit -m "feat: tile config loader with validation"
```

---

### Task 3: Cloudflare Access JWT verification

**Files:**
- Create: `src/auth.js`, `test/auth.test.js`

**Interfaces:**
- Produces:
  - `makeJwks(teamDomain: string) => JWKS resolver` (wraps `jose.createRemoteJWKSet`).
  - `async verifyAccessJwt(token: string, { jwks, issuer, audience }) => payload` — resolves to JWT claims (`email`, `sub`, ...); rejects on missing/invalid/expired/wrong-aud/wrong-issuer token.
  - `extractToken(headers: object, cookieHeader: string) => string|null` — pulls JWT from `cf-access-jwt-assertion` header or `CF_Authorization` cookie.

- [ ] **Step 1: Write the failing test** — `test/auth.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyAccessJwt, extractToken } from '../src/auth.js';

const ISS = 'https://clydeford.cloudflareaccess.com';
const AUD = 'test-aud-tag';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'k1'; pub.alg = 'ES256';
  const jwks = createLocalJWKSet({ keys: [pub] });
  const sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISS).setAudience(AUD)
      .setIssuedAt().setExpirationTime(opts.exp || '1h')
      .sign(privateKey);
  return { jwks, sign };
}

test('valid token returns claims', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'stevie.johnston@gmail.com' });
  const payload = await verifyAccessJwt(token, { jwks, issuer: ISS, audience: AUD });
  assert.equal(payload.email, 'stevie.johnston@gmail.com');
});

test('missing token rejects', async () => {
  const { jwks } = await setup();
  await assert.rejects(() => verifyAccessJwt(null, { jwks, issuer: ISS, audience: AUD }), /missing token/);
});

test('wrong audience rejects', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'x' });
  await assert.rejects(() => verifyAccessJwt(token, { jwks, issuer: ISS, audience: 'other' }));
});

test('expired token rejects', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'x' }, { exp: '-1h' });
  await assert.rejects(() => verifyAccessJwt(token, { jwks, issuer: ISS, audience: AUD }));
});

test('extractToken reads header then cookie', () => {
  assert.equal(extractToken({ 'cf-access-jwt-assertion': 'H' }, ''), 'H');
  assert.equal(extractToken({}, 'foo=1; CF_Authorization=C; bar=2'), 'C');
  assert.equal(extractToken({}, ''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth.test.js`
Expected: FAIL — cannot find `../src/auth.js`.

- [ ] **Step 3: Implement `src/auth.js`**

```javascript
import { jwtVerify, createRemoteJWKSet } from 'jose';

export function makeJwks(teamDomain) {
  return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
}

export async function verifyAccessJwt(token, { jwks, issuer, audience }) {
  if (!token) throw new Error('missing token');
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return payload;
}

export function extractToken(headers, cookieHeader) {
  const h = headers?.['cf-access-jwt-assertion'];
  if (h) return Array.isArray(h) ? h[0] : h;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'CF_Authorization') return v.join('=');
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/auth.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.js test/auth.test.js && git commit -m "feat: Cloudflare Access JWT verification"
```

---

### Task 4: PTY session wrapper

**Files:**
- Create: `src/pty-session.js`, `test/pty-session.test.js`

**Interfaces:**
- Produces: `spawnCmd({ cwd, fallbackDir, cols, rows }) => PtyProcess` — spawns `cmd.exe` in `cwd` if it exists, else `fallbackDir`. Returns the node-pty process (has `.onData`, `.write`, `.resize`, `.kill`, `.onExit`).
- Consumes: the pty package specifier verified in Task 1 (default `node-pty`).

> If Task 1 fell back to `@homebridge/node-pty-prebuilt-multiarch`, change the import on the first line accordingly.

- [ ] **Step 1: Write the failing test** — `test/pty-session.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCmd } from '../src/pty-session.js';

test('spawns cmd.exe and echoes output', async () => {
  const term = spawnCmd({ cwd: process.cwd(), fallbackDir: process.cwd(), cols: 80, rows: 24 });
  const out = await new Promise((resolve) => {
    let buf = '';
    term.onData((d) => { buf += d; if (buf.includes('PONGTEST')) resolve(buf); });
    term.write('echo PONGTEST\r');
    setTimeout(() => resolve(buf), 4000);
  });
  term.kill();
  assert.match(out, /PONGTEST/);
});

test('falls back when cwd does not exist', async () => {
  const term = spawnCmd({ cwd: 'C:\\does\\not\\exist\\xyz', fallbackDir: process.cwd(), cols: 80, rows: 24 });
  assert.ok(term);  // did not throw
  term.kill();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-session.test.js`
Expected: FAIL — cannot find `../src/pty-session.js`.

- [ ] **Step 3: Implement `src/pty-session.js`**

```javascript
import pty from 'node-pty';
import { existsSync, statSync } from 'node:fs';

export function spawnCmd({ cwd, fallbackDir, cols = 120, rows = 30 }) {
  let dir = fallbackDir;
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) dir = cwd;
  } catch { /* use fallback */ }
  return pty.spawn('cmd.exe', [], {
    name: 'xterm-color',
    cols, rows,
    cwd: dir,
    env: process.env,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-session.test.js`
Expected: PASS (2 tests). If node-pty failed in Task 1 and no fallback worked, this is blocked — resolve Task 1 first.

- [ ] **Step 5: Commit**

```bash
git add src/pty-session.js test/pty-session.test.js && git commit -m "feat: cmd.exe PTY session wrapper with cwd fallback"
```

---

### Task 5: Audit logger

**Files:**
- Create: `src/audit.js`, add cases to `test/server.test.js` (created in Task 6) — here just unit-test audit.

**Interfaces:**
- Produces: `createAuditLogger(dir) => { event(type, fields), command(identity, line) }`. Writes newline-delimited JSON to `logs/audit-YYYY-MM-DD.log`. Falls back to `logs/audit.log` if date unavailable.

- [ ] **Step 1: Write the failing test** — `test/audit.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLogger } from '../src/audit.js';

test('writes ndjson event lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const log = createAuditLogger(dir);
  log.event('session_start', { email: 'a@b.com', path: 'C:\\x' });
  log.command('a@b.com', 'dir');
  const file = join(dir, readdirSync(dir)[0]);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'session_start');
  assert.equal(lines[0].email, 'a@b.com');
  assert.equal(lines[1].type, 'command');
  assert.equal(lines[1].line, 'dir');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audit.test.js`
Expected: FAIL — cannot find `../src/audit.js`.

- [ ] **Step 3: Implement `src/audit.js`**

```javascript
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createAuditLogger(dir) {
  mkdirSync(dir, { recursive: true });
  function write(obj) {
    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);
    const file = join(dir, `audit-${day}.log`);
    appendFileSync(file, JSON.stringify({ ts, ...obj }) + '\n');
  }
  return {
    event: (type, fields = {}) => write({ type, ...fields }),
    command: (identity, line) => write({ type: 'command', email: identity, line }),
  };
}
```

> Note: `new Date()` is fine in app/test runtime (the Date restriction only applies to Workflow scripts, not to this Node app).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audit.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/audit.js test/audit.test.js && git commit -m "feat: ndjson audit logger"
```

---

### Task 6: HTTP + WebSocket server with JWT gate, single-session, audit, idle timeout

**Files:**
- Create: `src/server.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `loadTiles` (T2), `makeJwks`/`verifyAccessJwt`/`extractToken` (T3), `spawnCmd` (T4), `createAuditLogger` (T5).
- Produces: `createServer({ tiles, verifier, audit, fallbackDir, idleMinutes }) => { server, close() }` where `verifier(token) => Promise<payload>` (injected so tests can stub it). Default entrypoint reads `.env` and starts listening.
- HTTP routes: `GET /` → dashboard; `GET /terminal` → terminal page; `GET /api/tiles` → JSON tiles; static `/public/*` and `/vendor/*`. All gated by JWT.
- WS: client→server JSON messages `{type:'input',data}`, `{type:'resize',cols,rows}`, `{type:'start',tilePath}`; server→client `{type:'data',data}`, `{type:'exit'}`, `{type:'error',message}`.

- [ ] **Step 1: Write the failing test** — `test/server.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

function startWith(verifier) {
  const audit = { event() {}, command() {} };
  const tiles = [{ label: 'CWD', path: process.cwd(), icon: '📁' }];
  const { server, close } = createServer({
    tiles, verifier, audit, fallbackDir: process.cwd(), idleMinutes: 60,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, close })));
}

test('rejects HTTP without valid JWT (403)', async () => {
  const { port, close } = await startWith(async () => { throw new Error('bad'); });
  const r = await fetch(`http://127.0.0.1:${port}/api/tiles`);
  assert.equal(r.status, 403);
  await close();
});

test('serves tiles with valid JWT', async () => {
  const { port, close } = await startWith(async () => ({ email: 'a@b.com' }));
  const r = await fetch(`http://127.0.0.1:${port}/api/tiles`, {
    headers: { 'cf-access-jwt-assertion': 'x' },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body[0].label, 'CWD');
  await close();
});

test('WS runs a command and streams output', async () => {
  const { port, close } = await startWith(async () => ({ email: 'a@b.com' }));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { 'cf-access-jwt-assertion': 'x' },
  });
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }));
      ws.send(JSON.stringify({ type: 'input', data: 'echo WSPONG\r' }));
    });
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.type === 'data') { buf += msg.data; if (buf.includes('WSPONG')) resolve(buf); }
    });
    ws.on('error', reject);
    setTimeout(() => resolve(buf), 5000);
  });
  ws.close();
  assert.match(out, /WSPONG/);
  await close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — cannot find `../src/server.js`.

- [ ] **Step 3: Implement `src/server.js`**

```javascript
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadTiles } from './config.js';
import { makeJwks, verifyAccessJwt, extractToken } from './auth.js';
import { spawnCmd } from './pty-session.js';
import { createAuditLogger } from './audit.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function createServer({ tiles, verifier, audit, fallbackDir, idleMinutes }) {
  let active = null; // { ws, term, email, lastActivity, lineBuf }

  async function authed(req) {
    const token = extractToken(req.headers, req.headers.cookie || '');
    return verifier(token); // throws if invalid
  }

  function serveStatic(res, fileRel) {
    const file = join(PUBLIC, fileRel);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const server = http.createServer(async (req, res) => {
    let payload;
    try { payload = await authed(req); }
    catch { res.writeHead(403); return res.end('forbidden'); }

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' ) return serveStatic(res, 'index.html');
    if (url.pathname === '/terminal') return serveStatic(res, 'terminal.html');
    if (url.pathname === '/api/tiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(tiles));
    }
    if (url.pathname === '/api/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ email: payload.email || payload.sub || 'unknown' }));
    }
    if (url.pathname.startsWith('/vendor/')) return serveStatic(res, url.pathname.slice(1));
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
      return serveStatic(res, url.pathname.replace(/^\//, ''));
    res.writeHead(404); res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let payload;
    try { payload = await authed(req); }
    catch { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, payload));
  });

  function onConnect(ws, payload) {
    const email = payload.email || payload.sub || 'unknown';
    // Single-session: take over.
    if (active) {
      try { active.ws.send(JSON.stringify({ type: 'error', message: 'Session taken over by a new connection.' })); } catch {}
      try { active.term.kill(); } catch {}
      try { active.ws.close(); } catch {}
    }
    const session = { ws, term: null, email, lastActivity: Date.now(), lineBuf: '' };
    active = session;

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      session.lastActivity = Date.now();
      if (msg.type === 'start') {
        if (session.term) return;
        const term = spawnCmd({ cwd: msg.tilePath, fallbackDir, cols: msg.cols || 120, rows: msg.rows || 30 });
        session.term = term;
        audit.event('session_start', { email, path: msg.tilePath });
        term.onData((d) => { try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} });
        term.onExit(() => { try { ws.send(JSON.stringify({ type: 'exit' })); } catch {}; });
      } else if (msg.type === 'input' && session.term) {
        for (const ch of msg.data) {
          if (ch === '\r' || ch === '\n') {
            if (session.lineBuf.trim()) audit.command(email, session.lineBuf);
            session.lineBuf = '';
          } else if (ch === '') { session.lineBuf = ''; }
          else { session.lineBuf += ch; }
        }
        session.term.write(msg.data);
      } else if (msg.type === 'resize' && session.term) {
        try { session.term.resize(msg.cols, msg.rows); } catch {}
      }
    });

    ws.on('close', () => {
      if (session.term) { try { session.term.kill(); } catch {} }
      audit.event('session_stop', { email });
      if (active === session) active = null;
    });
  }

  const idleMs = (idleMinutes || 15) * 60 * 1000;
  const idleTimer = setInterval(() => {
    if (active && Date.now() - active.lastActivity > idleMs) {
      try { active.ws.send(JSON.stringify({ type: 'error', message: 'Idle timeout.' })); } catch {}
      try { active.term?.kill(); } catch {}
      try { active.ws.close(); } catch {}
    }
  }, 30000);
  idleTimer.unref?.();

  return {
    server,
    close: () => new Promise((res) => { clearInterval(idleTimer); wss.close(); server.close(res); }),
  };
}

// Entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const env = readEnv(join(ROOT, '.env'));
  const tiles = loadTiles(join(ROOT, 'config.json'));
  const jwks = makeJwks(env.ACCESS_TEAM_DOMAIN);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const audience = env.ACCESS_AUD;
  const audit = createAuditLogger(join(ROOT, 'logs'));
  const verifier = (token) => verifyAccessJwt(token, { jwks, issuer, audience });
  const { server } = createServer({
    tiles, verifier, audit, fallbackDir: env.FALLBACK_DIR,
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 15),
  });
  const port = Number(env.PORT || 7900);
  server.listen(port, env.BIND || '0.0.0.0', () => console.log(`listening on ${env.BIND}:${port}`));
}

function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS (3 tests). The WS test depends on a working node-pty (Task 1/4).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests PASS across config/auth/pty-session/audit/server.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js && git commit -m "feat: HTTP+WS server with JWT gate, single-session, audit, idle timeout"
```

---

### Task 7: Dashboard UI (smart tiles)

**Files:**
- Create: `public/index.html`, `public/dashboard.js`, `public/styles.css`

**Interfaces:**
- Consumes: `GET /api/tiles`, `GET /api/me`. Navigates to `/terminal?path=<encoded tile path>` on tile click.

- [ ] **Step 1: Create `public/styles.css`**

```css
:root { --bg:#0b0f17; --card:#151b27; --accent:#3b82f6; --text:#e5e7eb; --muted:#94a3b8; }
* { box-sizing: border-box; }
body { margin:0; font-family: 'Segoe UI', system-ui, sans-serif; background:var(--bg); color:var(--text); }
header { padding:24px 32px; border-bottom:1px solid #1f2937; display:flex; justify-content:space-between; align-items:center; }
header h1 { margin:0; font-size:20px; letter-spacing:.5px; }
header .who { color:var(--muted); font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:20px; padding:32px; }
.tile { background:var(--card); border:1px solid #1f2937; border-radius:14px; padding:22px; cursor:pointer;
  transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease; }
.tile:hover { transform:translateY(-3px); border-color:var(--accent); box-shadow:0 8px 24px rgba(59,130,246,.15); }
.tile .icon { font-size:34px; }
.tile .label { margin-top:12px; font-size:17px; font-weight:600; }
.tile .path { margin-top:6px; font-size:12px; color:var(--muted); word-break:break-all; font-family:Consolas,monospace; }
#terminal-host { height:calc(100vh - 70px); padding:8px; background:#000; }
.term-header { padding:14px 24px; border-bottom:1px solid #1f2937; display:flex; gap:16px; align-items:center; }
.term-header a { color:var(--accent); text-decoration:none; font-size:14px; }
.term-header .path { color:var(--muted); font-family:Consolas,monospace; font-size:13px; }
```

- [ ] **Step 2: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>access · clydeford</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>⌘ CMD Access</h1>
    <span class="who" id="who"></span>
  </header>
  <main class="grid" id="grid"></main>
  <script src="/dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `public/dashboard.js`**

```javascript
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
```

- [ ] **Step 4: Manual smoke check**

Run `npm start`, then with the app temporarily reachable (or via a stub JWT in dev), confirm `GET /` returns the dashboard HTML and `/api/tiles` returns the crucible tile. (Full browser check happens in Task 11 behind Access.)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/dashboard.js public/styles.css && git commit -m "feat: dashboard UI with smart tiles"
```

---

### Task 8: Terminal UI (xterm.js)

**Files:**
- Create: `public/terminal.html`, `public/terminal.js`

**Interfaces:**
- Consumes: `/vendor/xterm.js`, `/vendor/xterm.css`, `/vendor/addon-fit.js`; WS `/ws` with the message protocol from Task 6; query params `path`, `label`.

- [ ] **Step 1: Create `public/terminal.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>terminal · clydeford</title>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/vendor/xterm.css" />
</head>
<body>
  <div class="term-header">
    <a href="/">← tiles</a>
    <span class="path" id="path"></span>
    <a href="#" id="restart">restart</a>
  </div>
  <div id="terminal-host"></div>
  <script src="/vendor/xterm.js"></script>
  <script src="/vendor/addon-fit.js"></script>
  <script src="/terminal.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/terminal.js`**

```javascript
const params = new URLSearchParams(location.search);
const tilePath = params.get('path') || '';
document.getElementById('path').textContent = (params.get('label') || '') + '  ' + tilePath;

const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 14,
  theme: { background: '#000000' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal-host'));
fit.fit();

let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'start', tilePath, cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'exit') term.write('\r\n[process exited]\r\n');
    else if (msg.type === 'error') term.write(`\r\n[${msg.message}]\r\n`);
  };
  ws.onclose = () => term.write('\r\n[disconnected]\r\n');
}
connect();

term.onData((d) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
window.addEventListener('resize', () => {
  fit.fit();
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
});
document.getElementById('restart').onclick = (e) => { e.preventDefault(); location.reload(); };
```

- [ ] **Step 3: Manual smoke check**

With `npm start` running and node-pty working, load `/terminal?path=C:\cloudflare_projects\crucible` in a browser that can reach the dev port; confirm a prompt appears in that directory and `dir` works. (Full Access-gated check in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add public/terminal.html public/terminal.js && git commit -m "feat: xterm.js interactive terminal UI"
```

---

### Task 9: Cloudflare wiring (Access app → AUD, DNS, tunnel ingress)

**Files:**
- Create: `scripts/wire-cloudflare.js`

**Interfaces:**
- Reads `.env` for `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Creates the Access app, captures its `aud`, writes `ACCESS_AUD=<aud>` back into `.env`, creates the DNS CNAME, and adds the tunnel ingress rule preserving all existing rules.

- [ ] **Step 1: Create `scripts/wire-cloudflare.js`**

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const env = Object.fromEntries(readFileSync(ENV_PATH, 'utf8').split('\n')
  .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
  .map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]));

const ACC = env.CLOUDFLARE_ACCOUNT_ID;
const TOK = env.CLOUDFLARE_API_TOKEN;
const ZONE = '68c212a7f233ee505d871e816da19600';
const TUNNEL = 'ac9da5b2-eaf1-4761-913a-0da854ced2e0';
const MFA_POLICY = '8b4b68fb-ed1b-4e29-90a3-0b11cf2dbc96';
const HOST = 'access.clydeford.net';
const SERVICE = 'http://host.docker.internal:7900';
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };

async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!d.success) throw new Error(`${method} ${path} -> ${JSON.stringify(d.errors)}`);
  return d.result;
}

// 1. Access app (idempotent: reuse if exists)
const apps = await cf('GET', `/accounts/${ACC}/access/apps?per_page=100`);
let app = apps.find(a => a.domain === HOST);
if (!app) {
  app = await cf('POST', `/accounts/${ACC}/access/apps`, {
    name: 'access-cmd', domain: HOST, type: 'self_hosted',
    session_duration: '24h', policies: [MFA_POLICY],
  });
  console.log('created Access app', app.id);
} else {
  console.log('Access app already exists', app.id);
  // ensure the mfa policy is attached
  await cf('PUT', `/accounts/${ACC}/access/apps/${app.id}`, {
    name: app.name, domain: HOST, type: 'self_hosted',
    session_duration: '24h', policies: [MFA_POLICY],
  });
}
const aud = app.aud;
console.log('AUD =', aud);

// 2. Write AUD back to .env
let envText = readFileSync(ENV_PATH, 'utf8');
envText = /^ACCESS_AUD=/m.test(envText)
  ? envText.replace(/^ACCESS_AUD=.*$/m, `ACCESS_AUD=${aud}`)
  : envText.trimEnd() + `\nACCESS_AUD=${aud}\n`;
writeFileSync(ENV_PATH, envText);
console.log('wrote ACCESS_AUD to .env');

// 3. DNS CNAME (idempotent)
const recs = await cf('GET', `/zones/${ZONE}/dns_records?name=${HOST}`);
if (!recs.length) {
  await cf('POST', `/zones/${ZONE}/dns_records`, {
    type: 'CNAME', name: HOST, content: `${TUNNEL}.cfargotunnel.com`, proxied: true,
  });
  console.log('created DNS CNAME');
} else {
  console.log('DNS record already exists');
}

// 4. Tunnel ingress — insert before catch-all, preserve all rules
const cfg = await cf('GET', `/accounts/${ACC}/cfd_tunnel/${TUNNEL}/configurations`);
const config = cfg.config || {};
const ingress = config.ingress || [];
if (ingress.some(r => r.hostname === HOST)) {
  console.log('ingress rule already present');
} else {
  const catchAllIdx = ingress.findIndex(r => !r.hostname);
  const rule = { hostname: HOST, service: SERVICE };
  if (catchAllIdx === -1) ingress.push(rule, { service: 'http_status:404' });
  else ingress.splice(catchAllIdx, 0, rule);
  await cf('PUT', `/accounts/${ACC}/cfd_tunnel/${TUNNEL}/configurations`, { config: { ...config, ingress } });
  console.log('added ingress rule (catch-all preserved)');
}
console.log('DONE');
```

- [ ] **Step 2: Run it**

Run: `npm run wire`
Expected output includes `AUD = <tag>`, `wrote ACCESS_AUD to .env`, `created DNS CNAME` (or "already exists"), `added ingress rule (catch-all preserved)`, `DONE`.

- [ ] **Step 3: Verify ingress preserved the catch-all**

Run:
```bash
cd /c/cloudflare_projects/ssh && set -a && source .env && set +a
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/ac9da5b2-eaf1-4761-913a-0da854ced2e0/configurations" \
  | python -c "import sys,json;c=json.load(sys.stdin)['result']['config']['ingress'];print('access rule:', any(r.get('hostname')=='access.clydeford.net' for r in c));print('catch-all last:', c[-1].get('service'))"
```
Expected: `access rule: True` and `catch-all last: http_status:404`.

- [ ] **Step 4: Commit** (`.env` is gitignored, so only the script is committed)

```bash
git add scripts/wire-cloudflare.js && git commit -m "feat: cloudflare wiring script (access app, dns, ingress)"
```

---

### Task 10: Windows Firewall hardening

**Files:**
- Create: `scripts/firewall.ps1`

**Interfaces:**
- Produces a firewall rule allowing inbound TCP 7900 only from loopback + the Docker/WSL virtual subnet; blocking it from the physical LAN.

- [ ] **Step 1: Discover the Docker/WSL adapter subnet**

Run (PowerShell, as admin):
```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'WSL|vEthernet|Default Switch' } | Select-Object InterfaceAlias, IPAddress, PrefixLength
```
Note the subnet(s) (commonly `172.x.0.0/16` or `192.168.x.0/24`). Use them as `RemoteAddress` below.

- [ ] **Step 2: Create `scripts/firewall.ps1`**

```powershell
# Run as Administrator. Adjust $allowed to the subnet(s) found in Step 1.
$allowed = @('127.0.0.1', '172.16.0.0/12', '192.168.65.0/24')  # loopback + Docker Desktop ranges
Remove-NetFirewallRule -DisplayName 'access-cmd 7900' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'access-cmd 7900' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 7900 -RemoteAddress $allowed -Profile Any
# Explicit block for everything else on 7900
Remove-NetFirewallRule -DisplayName 'access-cmd 7900 deny' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'access-cmd 7900 deny' -Direction Inbound -Action Block `
  -Protocol TCP -LocalPort 7900 -Profile Any
Write-Output 'Firewall rules applied (allow takes precedence for listed subnets).'
```

> Note: Windows Firewall evaluates allow rules before block rules, so the scoped allow wins for the Docker subnet while the block stops all other inbound 7900.

- [ ] **Step 3: Apply it**

Run (admin PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1`
Expected: `Firewall rules applied...`.

- [ ] **Step 4: Verify the tunnel can still reach the app**

After Task 11's service/manual start, confirm the page loads through `access.clydeford.net`. If it 502s, the allow subnet is wrong — re-check Step 1 and widen `$allowed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/firewall.ps1 && git commit -m "feat: windows firewall hardening for port 7900"
```

---

### Task 11: Windows service + end-to-end validation

**Files:**
- Create: `scripts/install-service.js`, `scripts/uninstall-service.js`

**Interfaces:**
- Installs the app as an auto-starting Windows service named `AccessCmdTerminal`.

- [ ] **Step 1: Install node-windows**

```bash
cd /c/cloudflare_projects/ssh && npm install node-windows
```

- [ ] **Step 2: Create `scripts/install-service.js`**

```javascript
import { Service } from 'node-windows';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svc = new Service({
  name: 'AccessCmdTerminal',
  description: 'Browser CMD terminal for access.clydeford.net',
  script: join(ROOT, 'src', 'server.js'),
  nodeOptions: [],
  workingDirectory: ROOT,
});
svc.on('install', () => { console.log('installed; starting...'); svc.start(); });
svc.on('alreadyinstalled', () => console.log('already installed'));
svc.on('start', () => console.log('service started'));
svc.install();
```

- [ ] **Step 3: Create `scripts/uninstall-service.js`**

```javascript
import { Service } from 'node-windows';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svc = new Service({ name: 'AccessCmdTerminal', script: join(ROOT, 'src', 'server.js') });
svc.on('uninstall', () => console.log('uninstalled'));
svc.uninstall();
```

- [ ] **Step 4: Validate manually BEFORE installing the service**

Confirm `.env` has `ACCESS_AUD` set (from Task 9). Then:
```bash
cd /c/cloudflare_projects/ssh && npm start
```
Expected: `listening on 0.0.0.0:7900`. Leave it running for the next step.

- [ ] **Step 5: End-to-end check from an external machine/browser**

From a different machine, open `https://access.clydeford.net`:
1. Cloudflare Access prompts for MFA login → sign in as `stevie.johnston@gmail.com`.
2. Dashboard loads showing the **Crucible** tile.
3. Click it → terminal opens with prompt at `C:\cloudflare_projects\crucible`.
4. Run `dir` and `echo hello` → output streams live.
5. Verify the audit log:
```bash
cat /c/cloudflare_projects/ssh/logs/audit-*.log | tail -5
```
Expected: `session_start`, `command` lines (with the `dir`/`echo hello` text) and identity email.
6. Open a second tab/tile → confirm the first session is taken over (single-session rule).

- [ ] **Step 6: Install the service for persistence**

Stop the manual `npm start` (Ctrl+C), then (admin):
```bash
node scripts/install-service.js
```
Expected: `installed; starting...` then `service started`. Re-run the Step 5 browser check to confirm it works as a service.

- [ ] **Step 7: Commit**

```bash
git add scripts/install-service.js scripts/uninstall-service.js package.json package-lock.json && git commit -m "feat: windows service install + e2e validation"
```

---

## Self-Review

**Spec coverage:**
- Architecture/data flow → Tasks 6, 9 ✓
- Full interactive PTY → Tasks 4, 8 ✓
- Node.js stack → all ✓
- Smart tiles dashboard, config-driven, seeded with crucible → Tasks 1, 2, 7 ✓
- JWT verification (defense in depth) → Tasks 3, 6 ✓
- Reuse home-docker tunnel, bind 0.0.0.0 → Tasks 6, 9 ✓
- Audit log (sessions + commands) → Tasks 5, 6 ✓
- Single session → Task 6 ✓
- Cloudflare Access app + mfa policy, DNS, ingress → Task 9 ✓
- Windows Firewall restriction → Task 10 ✓
- Windows service persistence → Task 11 ✓
- Error handling (JWT, spawn fail, missing path, take-over, ingress preservation) → Tasks 4, 6, 9 ✓
- Testing (unit auth/config/audit, integration WS/PTY, manual e2e) → Tasks 2-6, 11 ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete. `ACCESS_AUD` is intentionally empty until Task 9 fills it (documented).

**Type consistency:** `spawnCmd({cwd,fallbackDir,cols,rows})`, `verifyAccessJwt(token,{jwks,issuer,audience})`, `extractToken(headers,cookie)`, `createAuditLogger(dir).{event,command}`, `loadTiles(path)`, `createServer({tiles,verifier,audit,fallbackDir,idleMinutes})` — used consistently across tasks. WS message types (`start`/`input`/`resize`/`data`/`exit`/`error`) match between server (T6) and terminal client (T8).

**Risks flagged:** node-pty native build (Task 1 verify + fallback); firewall subnet discovery (Task 10 Step 1); manual validation before service install (Task 11).
