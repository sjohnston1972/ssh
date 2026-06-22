import pty from 'node-pty';
import { existsSync, statSync } from 'node:fs';

export function spawnCmd({ cwd, fallbackDir, cols = 120, rows = 30, shell = 'powershell.exe' }) {
  let dir = fallbackDir;
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) dir = cwd;
  } catch { /* use fallback */ }
  return pty.spawn(shell, [], {
    name: 'xterm-color',
    cols, rows,
    cwd: dir,
    env: process.env,
  });
}
