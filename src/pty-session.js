import pty from 'node-pty';
import { existsSync, statSync } from 'node:fs';

export function spawnCmd({ cwd, fallbackDir, cols = 120, rows = 30 }) {
  let dir = fallbackDir;
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) dir = cwd;
  } catch { /* use fallback */ }
  return pty.spawn('cmd.exe', [], {
    name: 'xterm-color',
    cols, rows,
    cwd: dir,
    env: process.env,
  });
}
