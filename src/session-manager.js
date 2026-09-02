import { Buffer } from 'node:buffer';

// Strips ANSI/terminal escape sequences (CSI, OSC, charset-select, single-char ESC)
// from PTY output so echo-matching below compares against the actual printable text.
const ESC_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b[()#][0-9A-Za-z]|\x1b./g;
function stripAnsi(str) { return str.replace(ESC_RE, ''); }

export function createSessionManager({
  spawn, audit,
  idleMs = 900000, warnMs = 60000, graceMs = 600000, commandDelayMs = 500, bufferBytes = 262144,
  echoWindowMs = 300,
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
    clearTimer(s.idleTimer); clearTimer(s.warnTimer); clearTimer(s.graceTimer); clearTimer(s.echoTimer);
    s.idleTimer = s.warnTimer = s.graceTimer = s.echoTimer = null;
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
    s.term.onData((d) => { consumeEcho(s, d); appendBuffer(s, d); send(s.ws, { type: 'data', data: d }); });
    s.term.onExit(() => {
      send(s.ws, { type: 'exit' });
      if (sessions.get(s.identity) === s) { clearTimers(s); sessions.delete(s.identity); audit.event('session_stop', { email: s.identity, reason: 'exited' }); }
    });
  }

  // --- Interactive-line audit, gated on the PTY actually echoing what was typed ---
  //
  // Secrets typed at a non-echoing prompt (sudo/ssh/su/runas/etc.) must never reach the
  // audit log. Rather than pattern-matching known "Password:" prompt strings (fragile,
  // easy to bypass with an unrecognized prompt, and still requires briefly holding the
  // secret to do the matching), we watch the actual terminal echo state: a real
  // interactive terminal (PTY on POSIX, ConPTY on Windows) echoes typed characters back
  // through its output stream only while local echo is enabled; the foreground program
  // disables echo itself while reading a secret. So each typed character is held as
  // "pending" until the PTY's own output confirms it was echoed back (matched, in order,
  // against de-ANSI'd output). Only confirmed-echoed characters are ever appended to the
  // line buffer that gets audited. If a character isn't echoed back within `echoWindowMs`,
  // the whole line is flagged hidden: nothing typed on it is ever logged, and only a
  // content-free `command_redacted` marker is recorded so the audit trail still shows that
  // *something* was typed, without capturing what.
  function armEchoTimer(s) {
    clearTimer(s.echoTimer);
    s.echoTimer = setTimer(() => {
      s.echoTimer = null;
      if (s.pending) { s.lineHidden = true; s.pending = ''; }
      if (s.pendingEnter) finalizeLine(s);
    }, echoWindowMs);
  }
  function consumeEcho(s, output) {
    if (!s.pending) return;
    const clean = stripAnsi(output);
    let i = 0;
    while (i < s.pending.length && i < clean.length && s.pending[i] === clean[i]) i++;
    if (i > 0) { s.lineBuf += s.pending.slice(0, i); s.pending = s.pending.slice(i); }
    if (!s.pending) {
      clearTimer(s.echoTimer); s.echoTimer = null;
      if (s.pendingEnter) finalizeLine(s);
    } else if (i > 0) {
      armEchoTimer(s); // made progress: give the remainder a fresh window
    }
  }
  function finalizeLine(s) {
    clearTimer(s.echoTimer); s.echoTimer = null;
    if (s.lineHidden) {
      // Something was typed while the terminal's echo was off (a password/secret prompt).
      // Never write the captured characters, only that redaction happened.
      audit.event('command_redacted', { email: s.identity });
    } else if (s.lineBuf.trim()) {
      audit.command(s.identity, s.lineBuf);
    }
    s.lineBuf = ''; s.pending = ''; s.lineHidden = false; s.pendingEnter = false;
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
    const s = {
      identity, ws, term, buffer: [], bufferLen: 0, idleWarned: false, idleTimer: null, warnTimer: null, graceTimer: null,
      lineBuf: '', pending: '', lineHidden: false, pendingEnter: false, echoTimer: null,
    };
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
      if (ch === '\r' || ch === '\n') {
        if (s.pending) { s.pendingEnter = true; armEchoTimer(s); } // wait for trailing echo (or timeout) before deciding
        else finalizeLine(s);
      } else if (ch === '\x7f' || ch === '\x08') {
        if (s.pending) s.pending = s.pending.slice(0, -1);
        else s.lineBuf = s.lineBuf.slice(0, -1);
      } else {
        s.pending += ch;
        armEchoTimer(s);
      }
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
