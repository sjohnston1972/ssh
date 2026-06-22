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
  const start_msg = JSON.stringify({ type: 'start', tilePath: process.cwd() });
  const input_msg = JSON.stringify({ type: 'input', data: 'echo WSPONG\r' });
  ws.on('open', () => { ws.send(start_msg); ws.send(input_msg); });
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
