import { createSign, generateKeyPairSync } from 'node:crypto';

describe('OidcJwtVerifier', () => {
  it('accepts a valid RS256 token for the platform-api audience', async () => {
    let serviceModule: { OidcJwtVerifier?: new () => { verifyAccessToken: (token: string) => Promise<unknown> } } | null;

    try {
      serviceModule = require('../src/admin/oidc-jwt-verifier');
    } catch {
      serviceModule = null;
    }

    expect(serviceModule?.OidcJwtVerifier).toEqual(expect.any(Function));

    if (!serviceModule?.OidcJwtVerifier) {
      return;
    }

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const previousEnvironment = {
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_JWKS_URL: process.env.OIDC_JWKS_URL,
    };
    process.env.OIDC_ISSUER = 'https://issuer.example/realms/cyber-range';
    process.env.OIDC_JWKS_URL = 'https://issuer.example/realms/cyber-range/protocol/openid-connect/certs';

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: process.env.OIDC_ISSUER,
      sub: 'alice-subject',
      aud: 'platform-api',
      exp: now + 300,
      iat: now,
    };
    const token = signJwt(privateKey, payload, 'test-key');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256', kty: 'RSA' }],
        }),
        { status: 200 },
      ),
    );

    try {
      const verifier = new serviceModule.OidcJwtVerifier();

      await expect(verifier.verifyAccessToken(token)).resolves.toEqual(
        expect.objectContaining({
          issuer: process.env.OIDC_ISSUER,
          subject: 'alice-subject',
          audience: ['platform-api'],
        }),
      );
    } finally {
      fetchMock.mockRestore();
      Object.assign(process.env, previousEnvironment);
    }
  });

  it('rejects a token with the wrong audience', async () => {
    let serviceModule: { OidcJwtVerifier?: new () => { verifyAccessToken: (token: string) => Promise<unknown> } } | null;

    try {
      serviceModule = require('../src/admin/oidc-jwt-verifier');
    } catch {
      serviceModule = null;
    }

    expect(serviceModule?.OidcJwtVerifier).toEqual(expect.any(Function));

    if (!serviceModule?.OidcJwtVerifier) {
      return;
    }

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const previousEnvironment = {
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_JWKS_URL: process.env.OIDC_JWKS_URL,
    };
    process.env.OIDC_ISSUER = 'https://issuer.example/realms/cyber-range';
    process.env.OIDC_JWKS_URL = 'https://issuer.example/realms/cyber-range/protocol/openid-connect/certs';

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      privateKey,
      {
        iss: process.env.OIDC_ISSUER,
        sub: 'alice-subject',
        aud: 'mcp',
        exp: now + 300,
        iat: now,
      },
      'test-key',
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256', kty: 'RSA' }],
        }),
        { status: 200 },
      ),
    );

    try {
      const verifier = new serviceModule.OidcJwtVerifier();

      await expect(verifier.verifyAccessToken(token)).rejects.toThrow('OIDC token audience is invalid');
    } finally {
      fetchMock.mockRestore();
      Object.assign(process.env, previousEnvironment);
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
