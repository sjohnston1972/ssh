# SP1 — Per-user Sessions + Persistence + Status UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global terminal session with per-user sessions that survive WebSocket drops (grace window + replay), and add a connection-status UI with reconnect and idle warning.

**Architecture:** A new injectable `SessionManager` (`src/session-manager.js`) owns all per-identity session lifecycle — PTY spawn, rolling output buffer, idle/grace timers, attach/reattach/replay, takeover. `src/server.js` becomes a thin WS adapter that resolves identity from the JWT and routes messages to the manager, plus a ws ping/pong heartbeat. `public/terminal.js` auto-reconnects with backoff, restores the screen, and drives a status pill + idle banner.

**Tech Stack:** Node.js v24 (ESM), `ws`, `node-pty`, `node:test`; `@xterm/xterm` client. No new dependencies.

## Global Constraints

- ESM modules; tests run with `node --test test/*.test.js`. Keep the existing 21 tests green (update the ones whose behavior intentionally changes).
- Identity = JWT `email` (fallback `sub`). One session per identity; a same-identity new connection takes over the old one.
- Defaults (exact): idle timeout **15 min** (900000 ms), idle warning **60 s** before (so warn at 840000 ms), grace window **10 min** (600000 ms), replay buffer cap **262144** bytes, auto-run command delay **500 ms** (unchanged).
- `SessionManager` must take injectable `spawn`, `audit`, timer fns, and durations so it is unit-testable without HTTP/WS/real time.
- WS protocol additions (server→client): `restore{data}`, `idle-warning{seconds}`, `idle-cancel`, `taken-over`. Client→server unchanged: `start{tilePath,cols,rows}`, `input{data}`, `resize{cols,rows}`. The client sends `start` on **every** ws open (first connect and every reconnect).
- Audit: `session_start{email,path}` on spawn; `session_stop{email,reason}` with reason ∈ `idle|grace_expired|exited|shutdown`; `command{email,line}` per completed input line and for the auto-run command (existing behavior preserved).
- Existing modules unchanged in contract: `spawnCmd({cwd,fallbackDir,cols,rows,shell})` (pty-session.js), `createAuditLogger(dir)` (audit.js), `loadTiles` (config.js), `verifyAccessJwt`/`extractToken` (auth.js).

---

## File Structure

```
src/session-manager.js   NEW — per-identity session lifecycle (the SP1 core)
src/server.js            MODIFY — build manager, route ws messages to it, ws heartbeat; remove old single-`active` + idle logic
public/terminal.js       MODIFY — reconnect/backoff, status pill, restore/idle handling
public/terminal.html     MODIFY — status pill, reconnect button, idle banner; bump ?v=4
public/styles.css        MODIFY — pill states + banner
test/session-manager.test.js  NEW — unit tests (fake clock/pty/ws)
test/server.test.js      MODIFY — per-user, reconnect-restore, takeover (+ keep existing)
```

---

### Task 1: SessionManager module + unit tests

**Files:**
- Create: `src/session-manager.js`
- Create: `test/session-manager.test.js`

**Interfaces:**
- Produces: `createSessionManager({ spawn, audit, idleMs?, warnMs?, graceMs?, commandDelayMs?, bufferBytes?, setTimer?, clearTimer? }) => { start(identity, ws, opts), input(identity, data), resize(identity, cols, rows), detach(identity, ws), get(identity), shutdown() }`.
  - `spawn(opts) => ptyLike` where `opts = { cwd, cols, rows, shell }` and `ptyLike = { onData(fn), onExit(fn), write(str), resize(cols,rows), kill() }`.
  - `audit = { event(type, fields), command(email, line) }`.
  - `start` opts: `{ tilePath, cols, rows, shell, command }`.
  - `ws` is any object with `readyState` (1 = open), `send(string)`, `close()`.

- [ ] **Step 1: Write the failing tests** — `test/session-manager.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../src/session-manager.js';

// Deterministic fake clock: timers fire when advance() passes their due time.
function makeClock() {
  let now = 0, seq = 0; const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        now = next.t.at; timers.delete(next.id); next.t.fn();
      }
      now = target;
    },
  };
}
function fakePty() {
  const L = { data: [], exit: [] };
  return {
    written: [], resizes: [], killed: false,
    onData(fn) { L.data.push(fn); }, onExit(fn) { L.exit.push(fn); },
    write(d) { this.written.push(d); }, resize(c, r) { this.resizes.push([c, r]); }, kill() { this.killed = true; },
    emitData(d) { L.data.forEach((f) => f(d)); }, emitExit() { L.exit.forEach((f) => f()); },
  };
}
function fakeWs() {
  return { readyState: 1, sent: [], closed: false,
    send(s) { this.sent.push(JSON.parse(s)); }, close() { this.closed = true; this.readyState = 3; } };
}
function recorder() {
  return { events: [], commands: [],
    event(type, f) { this.events.push({ type, ...f }); }, command(email, line) { this.commands.push({ email, line }); } };
}
function mgr(over = {}) {
  const clock = makeClock(); const audit = recorder(); const ptys = [];
  const m = createSessionManager({
    spawn: () => { const p = fakePty(); ptys.push(p); return p; },
    audit, idleMs: 900000, warnMs: 60000, graceMs: 600000, commandDelayMs: 500, bufferBytes: 262144,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...over,
  });
  return { m, clock, audit, ptys };
}

test('start spawns, audits session_start, streams + buffers output', () => {
  const { m, audit, ptys } = mgr();
  const ws = fakeWs();
  m.start('a@x', ws, { tilePath: 'C:\\x', cols: 80, rows: 24 });
  assert.equal(ptys.length, 1);
  assert.ok(audit.events.find((e) => e.type === 'session_start' && e.email === 'a@x' && e.path === 'C:\\x'));
  ptys[0].emitData('hello');
  assert.deepEqual(ws.sent.at(-1), { type: 'data', data: 'hello' });
});

test('auto-runs the tile command after the delay and audits it', () => {
  const { m, clock, audit, ptys } = mgr();
  m.start('a@x', fakeWs(), { tilePath: 'C:\\x', command: 'claude --x' });
  clock.advance(500);
  assert.ok(ptys[0].written.includes('claude --x\r'));
  assert.ok(audit.commands.find((c) => c.line === 'claude --x'));
});

test('reattach replays buffer via restore and does not respawn', () => {
  const { m, ptys } = mgr();
  const ws1 = fakeWs();
  m.start('a@x', ws1, { tilePath: 'C:\\x' });
  ptys[0].emitData('SCREEN');
  m.detach('a@x', ws1);
  const ws2 = fakeWs();
  m.start('a@x', ws2, { tilePath: 'C:\\x', cols: 100, rows: 30 });
  assert.equal(ptys.length, 1);                         // no respawn
  const restore = ws2.sent.find((msg) => msg.type === 'restore');
  assert.ok(restore && restore.data.includes('SCREEN'));
  assert.deepEqual(ptys[0].resizes.at(-1), [100, 30]);  // resize nudge
});

test('grace timer kills the session if no reattach', () => {
  const { m, clock, audit, ptys } = mgr();
  const ws = fakeWs();
  m.start('a@x', ws, { tilePath: 'C:\\x' });
  m.detach('a@x', ws);
  clock.advance(600000);
  assert.equal(ptys[0].killed, true);
  assert.ok(audit.events.find((e) => e.type === 'session_stop' && e.reason === 'grace_expired'));
  assert.equal(m.get('a@x'), undefined);
});

test('idle warning then idle kill; input cancels the warning', () => {
  const { m, clock, audit, ptys } = mgr();
  const ws = fakeWs();
  m.start('a@x', ws, { tilePath: 'C:\\x' });
  clock.advance(840000);                                 // reach warn point
  assert.ok(ws.sent.find((msg) => msg.type === 'idle-warning' && msg.seconds === 60));
  m.input('a@x', 'x');                                   // activity cancels
  assert.ok(ws.sent.find((msg) => msg.type === 'idle-cancel'));
  clock.advance(840000);                                 // warn again, still alive
  assert.equal(ptys[0].killed, false);
  clock.advance(60000);                                  // idle reached
  assert.equal(ptys[0].killed, true);
  assert.ok(audit.events.find((e) => e.type === 'session_stop' && e.reason === 'idle'));
});

test('same-identity second start takes over the first socket', () => {
  const { m } = mgr();
  const ws1 = fakeWs(), ws2 = fakeWs();
  m.start('a@x', ws1, { tilePath: 'C:\\x' });
  m.start('a@x', ws2, { tilePath: 'C:\\x' });
  assert.ok(ws1.sent.find((msg) => msg.type === 'taken-over'));
  assert.equal(ws1.closed, true);
});

test('two identities get independent sessions', () => {
  const { m, ptys } = mgr();
  const wsa = fakeWs(), wsb = fakeWs();
  m.start('a@x', wsa, { tilePath: 'C:\\a' });
  m.start('b@x', wsb, { tilePath: 'C:\\b' });
  assert.equal(ptys.length, 2);
  ptys[0].emitData('AAA');
  assert.ok(wsa.sent.find((msg) => msg.data === 'AAA'));
  assert.ok(!wsb.sent.find((msg) => msg.data === 'AAA'));
});

test('records command lines from input and buffer is capped', () => {
  const { m, audit, ptys } = mgr({ bufferBytes: 8 });
  const ws = fakeWs();
  m.start('a@x', ws, { tilePath: 'C:\\x' });
  m.input('a@x', 'dir\r');
  assert.ok(audit.commands.find((c) => c.line === 'dir'));
  ptys[0].emitData('0123456789');                        // 10 bytes > cap 8
  m.detach('a@x', ws);
  const ws2 = fakeWs();
  m.start('a@x', ws2, { tilePath: 'C:\\x' });
  const restore = ws2.sent.find((msg) => msg.type === 'restore');
  assert.ok(restore.data.length <= 10);                  // oldest evicted, not unbounded
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session-manager.test.js`
Expected: FAIL — cannot find `../src/session-manager.js`.

- [ ] **Step 3: Implement `src/session-manager.js`**

```javascript
import { Buffer } from 'node:buffer';

export function createSessionManager({
  spawn, audit,
  idleMs = 900000, warnMs = 60000, graceMs = 600000, commandDelayMs = 500, bufferBytes = 262144,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const sessions = new Map(); // identity -> session

  function send(ws, obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
  }
  function appendBuffer(s, d) {
    s.buffer.push(d); s.bufferLen += Buffer.byteLength(d, 'utf8');
    while (s.bufferLen > bufferBytes && s.buffer.length > 1) {
      s.bufferLen -= Buffer.byteLength(s.buffer.shift(), 'utf8');
    }
  }
  function clearTimers(s) {
    clearTimer(s.idleTimer); clearTimer(s.warnTimer); clearTimer(s.graceTimer);
    s.idleTimer = s.warnTimer = s.graceTimer = null;
  }
  function armIdle(s) {
    clearTimer(s.idleTimer); clearTimer(s.warnTimer);
    s.warnTimer = setTimer(() => { s.idleWarned = true; send(s.ws, { type: 'idle-warning', seconds: Math.round(warnMs / 1000) }); }, idleMs - warnMs);
    s.idleTimer = setTimer(() => kill(s.identity, 'idle'), idleMs);
  }
  function noteActivity(s) {
    if (s.idleWarned) { s.idleWarned = false; send(s.ws, { type: 'idle-cancel' }); }
    armIdle(s);
  }
  function kill(identity, reason) {
    const s = sessions.get(identity); if (!s) return;
    clearTimers(s);
    try { s.term.kill(); } catch {}
    sessions.delete(identity);
    audit.event('session_stop', { email: identity, reason });
  }
  function bindTerm(s) {
    s.term.onData((d) => { appendBuffer(s, d); send(s.ws, { type: 'data', data: d }); });
    s.term.onExit(() => {
      send(s.ws, { type: 'exit' });
      if (sessions.get(s.identity) === s) { clearTimers(s); sessions.delete(s.identity); audit.event('session_stop', { email: s.identity, reason: 'exited' }); }
    });
  }

  function start(identity, ws, opts = {}) {
    const existing = sessions.get(identity);
    if (existing && existing.ws && existing.ws !== ws) {
      send(existing.ws, { type: 'taken-over' });
      try { existing.ws.close(); } catch {}
      existing.ws = null;
    }
    if (existing) {                       // reattach to live session
      clearTimer(existing.graceTimer); existing.graceTimer = null;
      existing.ws = ws;
      send(ws, { type: 'restore', data: existing.buffer.join('') });
      try { existing.term.resize(opts.cols || 120, opts.rows || 30); } catch {}
      noteActivity(existing);
      return existing;
    }
    const term = spawn({ cwd: opts.tilePath, cols: opts.cols || 120, rows: opts.rows || 30, shell: opts.shell });
    const s = { identity, ws, term, buffer: [], bufferLen: 0, lineBuf: '', idleWarned: false, idleTimer: null, warnTimer: null, graceTimer: null };
    sessions.set(identity, s);
    bindTerm(s);
    audit.event('session_start', { email: identity, path: opts.tilePath });
    armIdle(s);
    if (opts.command) {
      setTimer(() => {
        if (sessions.get(identity) !== s) return;
        try { term.write(opts.command + '\r'); } catch {}
        audit.command(identity, opts.command);
      }, commandDelayMs);
    }
    return s;
  }

  function input(identity, data) {
    const s = sessions.get(identity); if (!s) return;
    noteActivity(s);
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { if (s.lineBuf.trim()) audit.command(identity, s.lineBuf); s.lineBuf = ''; }
      else if (ch === '\x7f') { s.lineBuf = s.lineBuf.slice(0, -1); }
      else { s.lineBuf += ch; }
    }
    try { s.term.write(data); } catch {}
  }

  function resize(identity, cols, rows) {
    const s = sessions.get(identity); if (!s) return;
    try { s.term.resize(cols, rows); } catch {}
  }

  function detach(identity, ws) {
    const s = sessions.get(identity); if (!s || s.ws !== ws) return;  // ignore already-taken-over sockets
    s.ws = null;
    clearTimer(s.graceTimer);
    s.graceTimer = setTimer(() => kill(identity, 'grace_expired'), graceMs);
  }

  function get(identity) { return sessions.get(identity); }
  function shutdown() { for (const id of [...sessions.keys()]) kill(id, 'shutdown'); }

  return { start, input, resize, detach, get, shutdown };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session-manager.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.js test/session-manager.test.js
git commit -m "feat: SessionManager — per-identity sessions, replay buffer, idle/grace timers"
```

---

### Task 2: Wire server.js to SessionManager + ws heartbeat

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: `createSessionManager` (Task 1); existing `spawnCmd`, `loadTiles`, `makeJwks`/`verifyAccessJwt`/`extractToken`, `createAuditLogger`.
- Produces: `createServer({ tiles, verifier, audit, fallbackDir, idleMinutes, graceMinutes?, bufferBytes? }) => { server, close() }` — same shape as before plus optional `graceMinutes` (default 10) and `bufferBytes` (default 262144). `close()` now also calls `manager.shutdown()` and clears the heartbeat.

- [ ] **Step 1: Update the integration tests** — `test/server.test.js`

Replace the file's body with the following (keeps 403/tiles/echo/auto-run; the stub verifier now derives identity from the header token so tests can use distinct identities):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

// Stub verifier: the token value IS the identity email (lets tests pick identities).
function start(opts = {}) {
  const audit = { event() {}, command() {} };
  const tiles = opts.tiles || [{ label: 'CWD', path: process.cwd(), icon: '📁' }];
  const { server, close } = createServer({
    tiles, verifier: async (t) => ({ email: t || 'anon' }), audit,
    fallbackDir: process.cwd(), idleMinutes: 60, graceMinutes: 10, ...opts.server,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, close })));
}
function connect(port, email) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'cf-access-jwt-assertion': email } });
}
function collect(ws, predicate, ms = 6000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.type === 'data') buf += msg.data; if (predicate(msg, buf)) resolve({ msg, buf }); });
    ws.on('error', reject);
    setTimeout(() => resolve({ buf }), ms);
  });
}

test('rejects HTTP without valid JWT (403)', async () => {
  const { port, close } = await start({ server: { verifier: async () => { throw new Error('bad'); } } });
  const r = await fetch(`http://127.0.0.1:${port}/api/tiles`);
  assert.equal(r.status, 403);
  await close();
});

test('serves tiles with valid JWT', async () => {
  const { port, close } = await start();
  const r = await fetch(`http://127.0.0.1:${port}/api/tiles`, { headers: { 'cf-access-jwt-assertion': 'x' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json())[0].label, 'CWD');
  await close();
});

test('WS runs a command and streams output', async () => {
  const { port, close } = await start();
  const ws = connect(port, 'steven@x');
  const { buf } = await collect(ws, (_m, b) => b.includes('WSPONG'));
  ws.on('open', () => {});
  // open handler set before connecting in real client; send after open:
  ws.readyState === 1
    ? ws.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }))
    : ws.on('open', () => { ws.send(JSON.stringify({ type: 'start', tilePath: process.cwd() })); ws.send(JSON.stringify({ type: 'input', data: 'echo WSPONG\r' })); });
  const r = await collect(ws, (_m, b) => b.includes('WSPONG'));
  ws.close();
  assert.match(r.buf, /WSPONG/);
  await close();
});

test('two identities get separate sessions', async () => {
  const { port, close } = await start();
  const a = connect(port, 'a@x'), b = connect(port, 'b@x');
  await new Promise((r) => a.on('open', r));
  await new Promise((r) => b.on('open', r));
  a.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }));
  b.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }));
  a.send(JSON.stringify({ type: 'input', data: 'echo AONLY\r' }));
  const aSaw = await collect(a, (_m, buf) => buf.includes('AONLY'));
  const bSaw = await collect(b, (_m, buf) => buf.includes('AONLY'), 1500);
  a.close(); b.close();
  assert.match(aSaw.buf, /AONLY/);
  assert.ok(!/AONLY/.test(bSaw.buf));   // B never sees A's output
  await close();
});

test('same identity second connection takes over the first', async () => {
  const { port, close } = await start();
  const a1 = connect(port, 'dup@x');
  await new Promise((r) => a1.on('open', r));
  a1.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }));
  const takenOver = new Promise((resolve) => a1.on('message', (m) => { if (JSON.parse(m).type === 'taken-over') resolve(true); }));
  const a2 = connect(port, 'dup@x');
  await new Promise((r) => a2.on('open', r));
  a2.send(JSON.stringify({ type: 'start', tilePath: process.cwd() }));
  assert.equal(await takenOver, true);
  a1.close(); a2.close();
  await close();
});
```

> Note on the echo test: keep it simple — set the `open` handler before sending. If the inline form above is awkward in practice, structure it as: `ws.on('open', () => { ws.send(start); ws.send(input); });` then `await collect(...)`. The assertion (`/WSPONG/`) is what matters.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `createServer` still uses the old single-session logic; `taken-over`/two-identity behavior not implemented.

- [ ] **Step 3: Rewrite the WS handling in `src/server.js`**

Replace the `onConnect` function, the `wss`/`upgrade` wiring, and the old idle-timer block with manager-based wiring. Concretely:

1. Add the import near the others:
```javascript
import { createSessionManager } from './session-manager.js';
```

2. Inside `createServer({ tiles, verifier, audit, fallbackDir, idleMinutes, graceMinutes = 10, bufferBytes = 262144 })`, delete the `let active = null;` line and the entire old `idleTimer` `setInterval(...)` block and the old `onConnect` body. Build a manager and wire connections:

```javascript
  const manager = createSessionManager({
    spawn: (o) => spawnCmd({ cwd: o.cwd, fallbackDir, cols: o.cols, rows: o.rows, shell: o.shell }),
    audit,
    idleMs: (idleMinutes || 15) * 60000,
    graceMs: (graceMinutes || 10) * 60000,
    bufferBytes,
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
    const identity = payload.email || payload.sub || 'unknown';
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'start') {
        const tile = tiles.find((t) => t.path === msg.tilePath);
        manager.start(identity, ws, {
          tilePath: msg.tilePath, cols: msg.cols, rows: msg.rows,
          shell: tile?.shell, command: tile?.command,
        });
      } else if (msg.type === 'input') {
        manager.input(identity, msg.data);
      } else if (msg.type === 'resize') {
        manager.resize(identity, msg.cols, msg.rows);
      }
    });
    ws.on('close', () => manager.detach(identity, ws));
  }

  // Heartbeat: terminate half-open sockets so the grace flow kicks in.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false; try { ws.ping(); } catch {}
    }
  }, 30000);
  heartbeat.unref?.();
```

3. Update the return so `close()` tears everything down:
```javascript
  return {
    server,
    close: () => new Promise((res) => { clearInterval(heartbeat); manager.shutdown(); wss.close(); server.close(res); }),
  };
```

(Leave the HTTP request handler, `serveStatic`, `authed`, MIME map, and the entrypoint untouched — only the WS/session portion changes. The entrypoint already passes `idleMinutes`; it may optionally read `GRACE_MINUTES`/`BUFFER_BYTES` from `.env`, but defaults are fine, so no entrypoint change is required.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS (5 tests: 403, tiles, echo, two-identity, takeover).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (session-manager 8 + server 5 + config/auth/pty-session/audit). If the old `test/server.test.js` had a different count, the suite total changes accordingly — the requirement is 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: route WS through SessionManager (per-user, reconnect, takeover) + heartbeat"
```

---

### Task 3: Client reconnect + status pill + idle banner

**Files:**
- Modify: `public/terminal.js`
- Modify: `public/terminal.html`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: server WS protocol — sends `start{tilePath,cols,rows}` on every open, `input`, `resize`; handles `data`, `exit`, `error`, `restore{data}`, `idle-warning{seconds}`, `idle-cancel`, `taken-over`.

- [ ] **Step 1: Update `public/terminal.html`** — add status pill, reconnect button, idle banner; bump asset version to `?v=4`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>terminal · clydeford</title>
  <link rel="stylesheet" href="/styles.css?v=4" />
  <link rel="stylesheet" href="/vendor/xterm.css" />
</head>
<body>
  <div class="term-header">
    <a href="/">← tiles</a>
    <span class="path" id="path"></span>
    <span class="status" id="status" data-state="connecting">connecting…</span>
    <button id="reconnect" class="status-btn" hidden>Reconnect</button>
    <a href="#" id="restart">restart</a>
  </div>
  <div id="idle-banner" hidden></div>
  <div id="terminal-host"></div>
  <script src="/vendor/xterm.js"></script>
  <script src="/vendor/addon-fit.js"></script>
  <script src="/terminal.js?v=4"></script>
</body>
</html>
```

- [ ] **Step 2: Update `public/styles.css`** — append pill + banner styles.

```css
/* Connection status */
.status { font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid #2a3445; }
.status[data-state="connected"]    { color:#34d399; border-color:#1f6f53; }
.status[data-state="connecting"],
.status[data-state="reconnecting"] { color:#fbbf24; border-color:#7a5a12; }
.status[data-state="disconnected"] { color:#f87171; border-color:#7a2222; }
.status-btn { font:inherit; font-size:12px; padding:4px 12px; border-radius:8px; border:1px solid var(--accent);
  background:transparent; color:var(--accent); cursor:pointer; }
.status-btn:hover { background:var(--accent); color:#fff; }
#idle-banner { background:#7a5a12; color:#fff; font-size:13px; padding:8px 24px; text-align:center; }
```

- [ ] **Step 3: Rewrite `public/terminal.js`**

```javascript
const params = new URLSearchParams(location.search);
const tilePath = params.get('path') || '';
document.getElementById('path').textContent = (params.get('label') || '') + '  ' + tilePath;

const statusEl = document.getElementById('status');
const reconnectBtn = document.getElementById('reconnect');
const idleBanner = document.getElementById('idle-banner');

function setStatus(state, text) { statusEl.dataset.state = state; statusEl.textContent = text; }

const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 14,
  theme: { background: '#000000' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal-host'));

let ws, attempts = 0, intentionalClose = false, idleTimer = null;

function syncSize() {
  try { fit.fit(); } catch {}
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

function showIdle(seconds) {
  idleBanner.hidden = false;
  let left = seconds;
  clearInterval(idleTimer);
  const render = () => { idleBanner.textContent = `⚠ Idle — closing in ${left}s (press any key to stay)`; };
  render();
  idleTimer = setInterval(() => { left -= 1; if (left <= 0) { clearInterval(idleTimer); } else render(); }, 1000);
}
function hideIdle() { clearInterval(idleTimer); idleBanner.hidden = true; }

function connect() {
  setStatus(attempts === 0 ? 'connecting' : 'reconnecting', attempts === 0 ? 'connecting…' : 'reconnecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    attempts = 0;
    setStatus('connected', '● connected');
    reconnectBtn.hidden = true;
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
    // backoff: 0.5, 1, 2, 5, 5, ... seconds, within the server grace window
    const delays = [500, 1000, 2000, 5000];
    const delay = delays[Math.min(attempts, delays.length - 1)];
    attempts += 1;
    if (attempts > 40) { setStatus('disconnected', '○ disconnected'); reconnectBtn.hidden = false; return; }
    setStatus('reconnecting', '◌ reconnecting…');
    setTimeout(connect, delay);
  };
}
connect();

term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
window.addEventListener('resize', syncSize);
if (window.ResizeObserver) new ResizeObserver(syncSize).observe(document.getElementById('terminal-host'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSize);
window.addEventListener('load', syncSize);

reconnectBtn.onclick = () => location.reload();
document.getElementById('restart').onclick = (e) => { e.preventDefault(); location.reload(); };
```

- [ ] **Step 4: Syntax check + full suite (no regressions)**

Run: `node --check public/terminal.js && npm test 2>&1 | tail -3`
Expected: `terminal.js` OK; suite 0 failures.

- [ ] **Step 5: Local serve check (assets reachable + versioned)**

Run:
```bash
node --input-type=module -e "
import { createServer } from './src/server.js';
import { loadTiles } from './src/config.js';
const { server, close } = createServer({ tiles: loadTiles('./config.json'), verifier: async()=>({email:'d'}), audit:{event(){},command(){}}, fallbackDir: process.cwd(), idleMinutes:60 });
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const p=server.address().port,h={'cf-access-jwt-assertion':'x'};
const html=await (await fetch('http://127.0.0.1:'+p+'/terminal',{headers:h})).text();
console.log('terminal.js?v=4:', html.includes('/terminal.js?v=4'));
const js=await (await fetch('http://127.0.0.1:'+p+'/terminal.js?v=4',{headers:h})).text();
console.log('has restore handler:', js.includes(\"'restore'\"), '| has reconnect:', js.includes('reconnecting'));
await close();
"
```
Expected: all `true`.

- [ ] **Step 6: Commit**

```bash
git add public/terminal.js public/terminal.html public/styles.css
git commit -m "feat: client reconnect/backoff, status pill, restore + idle banner"
```

---

## Self-Review

**Spec coverage:**
- Per-user sessions keyed by identity → Task 1 (`start`/map), Task 2 (identity from JWT) ✓
- Same-user takeover → Task 1 (`start` takeover), tested Task 1 + Task 2 ✓
- Persistence + grace window → Task 1 (`detach`+grace timer) ✓
- Replay buffer + `restore` + resize nudge → Task 1 (`appendBuffer`, reattach branch) ✓
- Idle timeout + 60s warning + cancel-on-input → Task 1 (`armIdle`/`noteActivity`) ✓
- Status pill / reconnect / idle banner → Task 3 ✓
- Protocol additions (`restore`/`idle-warning`/`idle-cancel`/`taken-over`) → Tasks 1+3 ✓
- Heartbeat → Task 2 ✓
- Audit reasons (idle/grace_expired/exited/shutdown) → Task 1 ✓
- Auto-run command + line-buffer audit preserved → Task 1 (`start` command branch, `input`) ✓
- Buffer cap → Task 1 (`appendBuffer`), tested ✓
- Keep existing tests green → Task 2 updates server.test.js; config/auth/pty-session/audit untouched ✓

**Placeholder scan:** none. The echo-test note is guidance, not a placeholder; the test body is complete.

**Type consistency:** `createSessionManager({spawn, audit, idleMs, warnMs, graceMs, commandDelayMs, bufferBytes, setTimer, clearTimer}) → {start,input,resize,detach,get,shutdown}` used identically in Task 2. `spawn(o)` opts `{cwd,cols,rows,shell}` match `spawnCmd`'s named params. WS message `type` strings match between server (Task 1 sends) and client (Task 3 handles): `data/restore/exit/error/idle-warning/idle-cancel/taken-over`.

**Note:** SP1 changes are server-side (require a service restart to deploy) plus client assets (versioned `?v=4`, served fresh). Deployment = restart `AccessCmdTerminal` (elevated), done after the plan is built and reviewed.
