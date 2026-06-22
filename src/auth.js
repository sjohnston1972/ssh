import { jwtVerify, createRemoteJWKSet } from 'jose';

export function makeJwks(teamDomain) {
  return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
}

export async function verifyAccessJwt(token, { jwks, issuer, audience }) {
  if (!token) throw new Error('missing token');
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return payload;
}

export function extractToken(headers, cookieHeader) {
  const h = headers?.['cf-access-jwt-assertion'];
  if (h) return Array.isArray(h) ? h[0] : h;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'CF_Authorization') return v.join('=');
    }
  }
  return null;
}
