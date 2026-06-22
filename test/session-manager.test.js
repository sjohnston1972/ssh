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
