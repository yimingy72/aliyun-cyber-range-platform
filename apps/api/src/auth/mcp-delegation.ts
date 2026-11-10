import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export function verifyMcpDelegation(token: string) {
  const key = process.env.OIDC_MCP_DELEGATION_KEY;
  const [prefix, payload, signature, ...rest] = token.split('.');
  const fail = () => new UnauthorizedException('Invalid internal MCP delegation');
  if (!key || key.length < 32 || prefix !== 'mcp-v1' || rest.length || !payload || payload.length > 4096 ||
      !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw fail();
  const expected = createHmac('sha256', key).update(prefix + '.' + payload).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) throw fail();
  let value;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw fail();
  }
  const now = Math.floor(Date.now() / 1000);
  if (!value || value.aud !== 'cyber-range-api-internal' || value.issuer !== process.env.OIDC_ISSUER?.trim() ||
      !Number.isInteger(value.exp) || value.exp <= now || value.exp > now + 20 ||
      typeof value.subject !== 'string' || !value.subject || typeof value.authorizedParty !== 'string' ||
      !value.authorizedParty || !Array.isArray(value.scopes) || value.scopes.some((scope: unknown) => typeof scope !== 'string')) throw fail();
  return { issuer: value.issuer as string, subject: value.subject as string, authorizedParty: value.authorizedParty as string, scopes: value.scopes as string[] };
}
