import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const env = Object.fromEntries(readFileSync(ENV_PATH, 'utf8').split('\n')
  .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
  .map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]));

const ACC = env.CLOUDFLARE_ACCOUNT_ID;
const TOK = env.CLOUDFLARE_API_TOKEN;
const ZONE = '68c212a7f233ee505d871e816da19600';
const TUNNEL = 'ac9da5b2-eaf1-4761-913a-0da854ced2e0';
const MFA_POLICY = '8b4b68fb-ed1b-4e29-90a3-0b11cf2dbc96';
const HOST = 'access.clydeford.net';
const SERVICE = 'http://host.docker.internal:7900';
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };

async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!d.success) throw new Error(`${method} ${path} -> ${JSON.stringify(d.errors)}`);
  return d.result;
}

// 1. Access app (idempotent: reuse if exists)
const apps = await cf('GET', `/accounts/${ACC}/access/apps?per_page=100`);
let app = apps.find(a => a.domain === HOST);
if (!app) {
  app = await cf('POST', `/accounts/${ACC}/access/apps`, {
    name: 'access-cmd', domain: HOST, type: 'self_hosted',
    session_duration: '24h', policies: [MFA_POLICY],
  });
  console.log('created Access app', app.id);
} else {
  console.log('Access app already exists', app.id);
  // ensure the mfa policy is attached
  await cf('PUT', `/accounts/${ACC}/access/apps/${app.id}`, {
    name: app.name, domain: HOST, type: 'self_hosted',
    session_duration: '24h', policies: [MFA_POLICY],
  });
}
const aud = app.aud;
console.log('AUD =', aud);

// 2. Write AUD back to .env
let envText = readFileSync(ENV_PATH, 'utf8');
envText = /^ACCESS_AUD=/m.test(envText)
  ? envText.replace(/^ACCESS_AUD=.*$/m, `ACCESS_AUD=${aud}`)
  : envText.trimEnd() + `\nACCESS_AUD=${aud}\n`;
writeFileSync(ENV_PATH, envText);
console.log('wrote ACCESS_AUD to .env');

// 3. DNS CNAME (idempotent)
const recs = await cf('GET', `/zones/${ZONE}/dns_records?name=${HOST}`);
if (!recs.length) {
  await cf('POST', `/zones/${ZONE}/dns_records`, {
    type: 'CNAME', name: HOST, content: `${TUNNEL}.cfargotunnel.com`, proxied: true,
  });
  console.log('created DNS CNAME');
} else {
  console.log('DNS record already exists');
}

// 4. Tunnel ingress — insert before catch-all, preserve all rules
const cfg = await cf('GET', `/accounts/${ACC}/cfd_tunnel/${TUNNEL}/configurations`);
const config = cfg.config || {};
const ingress = config.ingress || [];
if (ingress.some(r => r.hostname === HOST)) {
  console.log('ingress rule already present');
} else {
  const catchAllIdx = ingress.findIndex(r => !r.hostname);
  const rule = { hostname: HOST, service: SERVICE };
  if (catchAllIdx === -1) ingress.push(rule, { service: 'http_status:404' });
  else ingress.splice(catchAllIdx, 0, rule);
  await cf('PUT', `/accounts/${ACC}/cfd_tunnel/${TUNNEL}/configurations`, { config: { ...config, ingress } });
  console.log('added ingress rule (catch-all preserved)');
}
console.log('DONE');
