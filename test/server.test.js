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
