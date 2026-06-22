const params = new URLSearchParams(location.search);
const tilePath = params.get('path') || '';
document.getElementById('path').textContent = (params.get('label') || '') + '  ' + tilePath;

const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 14,
  theme: { background: '#000000' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal-host'));

let ws;

// Keep the PTY's reported size matched to the actually-rendered terminal.
// A premature fit (before fonts/layout settle) reports the wrong column count,
// which makes full-screen TUIs like Claude Code draw borders at the wrong width.
function syncSize() {
  try { fit.fit(); } catch {}
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    try { fit.fit(); } catch {}
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

term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });

window.addEventListener('resize', syncSize);
if (window.ResizeObserver) {
  new ResizeObserver(syncSize).observe(document.getElementById('terminal-host'));
}
if (document.fonts && document.fonts.ready) { document.fonts.ready.then(syncSize); }
window.addEventListener('load', syncSize);

document.getElementById('restart').onclick = (e) => { e.preventDefault(); location.reload(); };
