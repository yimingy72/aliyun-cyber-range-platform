import { createSign, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { OidcJwtVerifier } from '../src/oidc-jwt-verifier';

describe('MCP OidcJwtVerifier', () => {
  it('accepts a valid RS256 token for the mcp audience', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const env = {
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_JWKS_URL: process.env.OIDC_JWKS_URL,
      MCP_OIDC_AUDIENCE: process.env.MCP_OIDC_AUDIENCE,
    };
    process.env.OIDC_ISSUER = 'https://issuer.example/realms/cyber-range';
    process.env.OIDC_JWKS_URL = 'https://issuer.example/realms/cyber-range/protocol/openid-connect/certs';
    process.env.MCP_OIDC_AUDIENCE = 'mcp';

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      privateKey,
      {
        iss: process.env.OIDC_ISSUER,
        sub: 'alice-subject',
        aud: ['platform-web', 'mcp'],
        azp: 'platform-web',
        exp: now + 300,
        iat: now,
      },
      'test-key',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256', kty: 'RSA' }],
        }),
        { status: 200 },
      ),
    );

    try {
      const verifier = new OidcJwtVerifier();

      await expect(verifier.verifyAccessToken(token)).resolves.toEqual(
        expect.objectContaining({
          issuer: process.env.OIDC_ISSUER,
          subject: 'alice-subject',
          audience: ['platform-web', 'mcp'],
          authorizedParty: 'platform-web',
        }),
      );
    } finally {
      fetchMock.mockRestore();
      Object.assign(process.env, env);
    }
  });
});

function signJwt(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], payload: Record<string, unknown>, kid: string) {
  const encodedHeader = encodeSegment({ alg: 'RS256', typ: 'JWT', kid });
  const encodedPayload = encodeSegment(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function encodeSegment(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
