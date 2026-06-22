import { appendFileSync, mkdirSync } from 'node:fs';
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
