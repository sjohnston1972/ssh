import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadTiles } from './config.js';
import { makeJwks, verifyAccessJwt, extractToken } from './auth.js';
import { spawnCmd } from './pty-session.js';
import { createAuditLogger } from './audit.js';
import { createSessionManager } from './session-manager.js';
import { visibleTiles, tileAllowed } from './authz.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function createServer({ tiles, verifier, audit, fallbackDir, idleMinutes, graceMinutes = 10, bufferBytes = 262144 }) {
  async function authed(req) {
    const token = extractToken(req.headers, req.headers.cookie || '');
    return verifier(token); // throws if invalid
  }

  function securityHeaders(res) {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
  }

  function serveStatic(res, fileRel) {
    const file = resolve(PUBLIC, fileRel);
    if (relative(PUBLIC, file).startsWith('..') || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(readFileSync(file));
  }

  const server = http.createServer(async (req, res) => {
    let payload;
    try { payload = await authed(req); }
    catch { res.writeHead(403); return res.end('forbidden'); }

    securityHeaders(res);

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' ) return serveStatic(res, 'index.html');
    if (url.pathname === '/terminal') return serveStatic(res, 'terminal.html');
    if (url.pathname === '/api/tiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(visibleTiles(tiles, payload.email || payload.sub || 'unknown')));
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

  return {
    server,
    close: () => new Promise((res) => { clearInterval(heartbeat); manager.shutdown(); wss.close(); server.closeAllConnections?.(); server.close(res); }),
  };
}

// Entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = readEnv(join(ROOT, '.env'));
  const tiles = loadTiles(join(ROOT, 'config.json'));
  const jwks = makeJwks(env.ACCESS_TEAM_DOMAIN);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const audience = env.ACCESS_AUD;
  const audit = createAuditLogger(join(ROOT, 'logs'));
  if (!env.ACCESS_TEAM_DOMAIN || !audience) {
    console.error('FATAL: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set in .env (refusing to start without enforced JWT audience/issuer).');
    process.exit(1);
  }
  const verifier = (token) => verifyAccessJwt(token, { jwks, issuer, audience });
  const { server } = createServer({
    tiles, verifier, audit, fallbackDir: env.FALLBACK_DIR,
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 15),
    graceMinutes: Number(env.SESSION_GRACE_MINUTES || 10),
    bufferBytes: Number(env.SESSION_BUFFER_BYTES || 262144),
  });
  const port = Number(env.PORT || 7900);
  const bind = env.BIND || '0.0.0.0';
  server.listen(port, bind, () => console.log(`listening on ${bind}:${port}`));
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
