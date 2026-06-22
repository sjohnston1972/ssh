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
