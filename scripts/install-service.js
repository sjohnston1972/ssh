import { Service } from 'node-windows';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svc = new Service({
  name: 'AccessCmdTerminal',
  description: 'Browser CMD terminal for access.clydeford.net',
  script: join(ROOT, 'src', 'server.js'),
  nodeOptions: [],
  workingDirectory: ROOT,
});
svc.on('install', () => { console.log('installed; starting...'); svc.start(); });
svc.on('alreadyinstalled', () => console.log('already installed'));
svc.on('start', () => console.log('service started'));
svc.install();
