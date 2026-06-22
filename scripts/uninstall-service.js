import { Service } from 'node-windows';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svc = new Service({ name: 'AccessCmdTerminal', script: join(ROOT, 'src', 'server.js') });
svc.on('uninstall', () => console.log('uninstalled'));
svc.uninstall();
