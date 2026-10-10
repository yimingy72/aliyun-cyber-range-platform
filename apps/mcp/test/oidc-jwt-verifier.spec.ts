import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('OIDC JWKS rotation', () => {
  const environment = { ...process.env };
  beforeEach(() => { process.env.OIDC_ISSUER = 'https://issuer.invalid'; process.env.OIDC_JWKS_URL = 'https://issuer.invalid/jwks'; process.env.MCP_OIDC_AUDIENCE = 'mcp'; });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...environment }; });
  function setup() {
    const a = generateKeyPairSync('rsa', { modulusLength: 2048 }); const b = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = (pair: typeof a, kid: string) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
    const response = (includeB = false) => new Response(JSON.stringify({ keys: [key(a, 'key-a'), ...(includeB ? [key(b, 'key-b')] : [])] }), { status: 200 });
    const token = (pair: typeof a, kid: string) => signJwt(pair.privateKey, { iss: process.env.OIDC_ISSUER, sub: 'synthetic-subject', aud: 'mcp', exp: Math.floor(Date.now() / 1000) + 600 }, kid);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    return { a, b, response, token, fetchMock, verifier: new OidcJwtVerifier() };
  }
  it('refreshes an unknown rotation key once for simultaneous requests', async () => {
    const s = setup(); s.fetchMock.mockResolvedValueOnce(s.response()).mockResolvedValueOnce(s.response(true));
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    await Promise.all(Array.from({ length: 4 }, () => s.verifier.verifyAccessToken(s.token(s.b, 'key-b'))));
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated unknown-kid fetches while still accepting cached valid keys', async () => {
    const s = setup(); s.fetchMock.mockResolvedValueOnce(s.response()).mockResolvedValueOnce(s.response());
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    for (let i = 0; i < 4; i++) await expect(s.verifier.verifyAccessToken(s.token(s.a, `unknown-${i}`))).rejects.toThrow('OIDC signing key was not found');
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a')); expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('keeps the old cache after refresh failure and permits a later refresh', async () => {
    const s = setup(); s.fetchMock.mockResolvedValueOnce(s.response()).mockResolvedValueOnce(new Response(null, { status: 502 })).mockResolvedValueOnce(s.response(true));
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    await expect(s.verifier.verifyAccessToken(s.token(s.b, 'key-b'))).rejects.toThrow('OIDC JWKS fetch failed');
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    const later = Date.now() + 1001; vi.spyOn(Date, 'now').mockReturnValue(later);
    await s.verifier.verifyAccessToken(s.token(s.b, 'key-b')); expect(s.fetchMock).toHaveBeenCalledTimes(3);
  });
  it('accepts a cached key while an unrelated forced refresh is pending or fails', async () => {
    const s = setup(); let rejectRefresh!: (reason: Error) => void;
    s.fetchMock.mockResolvedValueOnce(s.response()).mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    const forced = s.verifier.verifyAccessToken(s.token(s.b, 'key-b'));
    const rejected = expect(forced).rejects.toThrow('Synthetic JWKS outage');
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    rejectRefresh(new Error('Synthetic JWKS outage')); await rejected;
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('still verifies the signature of a token after discovering its kid', async () => {
    const s = setup(); s.fetchMock.mockResolvedValueOnce(s.response()).mockResolvedValueOnce(s.response(true));
    await s.verifier.verifyAccessToken(s.token(s.a, 'key-a'));
    await expect(s.verifier.verifyAccessToken(s.token(s.a, 'key-b'))).rejects.toThrow('OIDC token signature is invalid');
  });
});

describe('OIDC JWT trust boundary', () => {
  const environment = { ...process.env };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://issuer.invalid'; process.env.OIDC_JWKS_URL = 'https://issuer.invalid/jwks'; process.env.MCP_OIDC_AUDIENCE = 'mcp';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] })));
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...environment }; });
  const payload = () => ({ iss: 'https://issuer.invalid', sub: 'subject', aud: 'mcp', exp: Math.floor(Date.now() / 1000) + 600 });
  it.each([{ sub: 42 }, { exp: '9999999999' }, { nbf: '0' }, { iat: '0' }, { scope: [] }, { azp: 10 }, { typ: 'ID' }, { aud: ['mcp', 42] }])('rejects malformed access token claims %j', async override => {
    await expect(new OidcJwtVerifier().verifyAccessToken(signJwt(pair.privateKey, { ...payload(), ...override }, 'test-key'))).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('rejects additional JWT segments and non-object payloads', async () => {
    const valid = signJwt(pair.privateKey, payload(), 'test-key');
    for (const token of [valid + '.trailing', valid.split('.')[0] + '.bnVsbA.' + valid.split('.')[2]]) {
      await expect(new OidcJwtVerifier().verifyAccessToken(token)).rejects.toThrow('malformed');
    }
  });
  it('never accepts an ID token with an access token audience', async () => {
    await expect(new OidcJwtVerifier().verifyAccessToken(signJwt(pair.privateKey, { ...payload(), typ: 'ID' }, 'test-key'))).rejects.toThrow('claims');
  });
  it('checks key purpose and expires the key cache', async () => {
    const verifier = new OidcJwtVerifier(); const token = signJwt(pair.privateKey, payload(), 'test-key');
    await verifier.verifyAccessToken(token);
    const later = Date.now() + 5 * 60_000 + 1; vi.spyOn(Date, 'now').mockReturnValue(later);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'enc' }] })));
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow('signing key');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
