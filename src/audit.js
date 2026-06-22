import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createAuditLogger(dir) {
  mkdirSync(dir, { recursive: true });
  function write(obj) {
    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);
    const file = join(dir, `audit-${day}.log`);
    appendFileSync(file, JSON.stringify({ ts, ...obj }) + '\n');
  }
  return {
    event: (type, fields = {}) => write({ type, ...fields }),
    command: (identity, line) => write({ type: 'command', email: identity, line }),
  };
}

const AUDIT_RE = /^audit-\d{4}-\d{2}-\d{2}\.log$/;

export function pruneOldLogs(dir, retentionDays = 30) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const f of readdirSync(dir)) {
    const m = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (!m) continue;
    const t = Date.parse(m[1] + 'T00:00:00Z');
    if (!Number.isNaN(t) && t < cutoff) { try { rmSync(join(dir, f)); } catch {} }
  }
}

export function readRecentAudit(dir, limit = 500) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => AUDIT_RE.test(f)).sort().reverse();
  const out = [];
  for (const f of files) {
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim(); if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
      if (out.length >= limit) return out;
    }
  }
  return out;
}
