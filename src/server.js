import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    const file = resolve(PUBLIC, fileRel);
    if (relative(PUBLIC, file).startsWith('..') || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
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
      try { active.term?.kill(); } catch {}
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
        term.onExit(() => { try { ws.send(JSON.stringify({ type: 'exit' })); } catch {} });
        // Auto-run a tile's configured startup command (typed + Enter) once the shell is ready.
        const tile = tiles.find((t) => t.path === msg.tilePath && t.command);
        if (tile) {
          const startupTimer = setTimeout(() => {
            if (session.term !== term) return; // session replaced/closed before timer fired
            try { term.write(tile.command + '\r'); } catch {}
            audit.command(email, tile.command);
          }, 500);
          startupTimer.unref?.();
        }
      } else if (msg.type === 'input' && session.term) {
        for (const ch of msg.data) {
          if (ch === '\r' || ch === '\n') {
            if (session.lineBuf.trim()) audit.command(email, session.lineBuf);
            session.lineBuf = '';
          } else if (ch === '') { session.lineBuf = session.lineBuf.slice(0, -1); }
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
