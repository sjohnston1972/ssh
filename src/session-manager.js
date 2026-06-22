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
    if (s.bufferLen > bufferBytes && s.buffer.length === 1) {
      let chunk = s.buffer[0];
      if (chunk.length > bufferBytes) chunk = chunk.slice(chunk.length - bufferBytes); // coarse char cut
      while (Buffer.byteLength(chunk, 'utf8') > bufferBytes && chunk.length > 0) chunk = chunk.slice(1);
      s.buffer[0] = chunk; s.bufferLen = Buffer.byteLength(chunk, 'utf8');
    }
  }
  function clearTimers(s) {
    clearTimer(s.idleTimer); clearTimer(s.warnTimer); clearTimer(s.graceTimer);
    s.idleTimer = s.warnTimer = s.graceTimer = null;
  }
  function armIdle(s) {
    clearTimer(s.graceTimer); s.graceTimer = null;
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
