import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyAccessJwt, extractToken } from '../src/auth.js';

const ISS = 'https://clydeford.cloudflareaccess.com';
const AUD = 'test-aud-tag';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'k1'; pub.alg = 'ES256';
  const jwks = createLocalJWKSet({ keys: [pub] });
  const sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISS).setAudience(AUD)
      .setIssuedAt().setExpirationTime(opts.exp || '1h')
      .sign(privateKey);
  return { jwks, sign };
}

test('valid token returns claims', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'stevie.johnston@gmail.com' });
  const payload = await verifyAccessJwt(token, { jwks, issuer: ISS, audience: AUD });
  assert.equal(payload.email, 'stevie.johnston@gmail.com');
});

test('missing token rejects', async () => {
  const { jwks } = await setup();
  await assert.rejects(() => verifyAccessJwt(null, { jwks, issuer: ISS, audience: AUD }), /missing token/);
});

test('wrong audience rejects', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'x' });
  await assert.rejects(() => verifyAccessJwt(token, { jwks, issuer: ISS, audience: 'other' }));
});

test('expired token rejects', async () => {
  const { jwks, sign } = await setup();
  const token = await sign({ email: 'x' }, { exp: '-1h' });
  await assert.rejects(() => verifyAccessJwt(token, { jwks, issuer: ISS, audience: AUD }));
});

test('extractToken reads header then cookie', () => {
  assert.equal(extractToken({ 'cf-access-jwt-assertion': 'H' }, ''), 'H');
  assert.equal(extractToken({}, 'foo=1; CF_Authorization=C; bar=2'), 'C');
  assert.equal(extractToken({}, ''), null);
});
