import { describe, expect, it, vi } from 'vitest';

import { exchangePlatformApiToken, resolvePlatformApiToken } from '../src/platform-session';

describe('exchangePlatformApiToken', () => {
  it('exchanges the inbound human token for a platform-api token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'platform-api-token',
          token_type: 'Bearer',
          expires_in: 300,
        }),
        { status: 200 },
      ),
    );

    try {
      await expect(
        exchangePlatformApiToken(
          {
            host: '127.0.0.1',
            port: 8787,
            platformApiBaseUrl: 'https://platform.example',
            oidcTokenEndpoint: 'https://issuer.example/realms/cyber-range/protocol/openid-connect/token',
            oidcClientId: 'mcp-gateway',
            oidcClientSecret: 'mcp-gateway-secret',
          },
          'human-access-token',
        ),
      ).resolves.toBe('platform-api-token');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];

      expect(url).toBe('https://issuer.example/realms/cyber-range/protocol/openid-connect/token');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });

      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      expect((body as URLSearchParams).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect((body as URLSearchParams).get('client_id')).toBe('mcp-gateway');
      expect((body as URLSearchParams).get('client_secret')).toBe('mcp-gateway-secret');
      expect((body as URLSearchParams).get('subject_token')).toBe('human-access-token');
      expect((body as URLSearchParams).get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
      expect((body as URLSearchParams).get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
      expect((body as URLSearchParams).get('audience')).toBe('platform-api');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('fails fast when no inbound oidc token or static token is available', async () => {
    await expect(
      resolvePlatformApiToken({
        host: '127.0.0.1',
        port: 8787,
        platformApiBaseUrl: 'https://platform.example',
      }),
    ).rejects.toThrow('Missing downstream platform API authentication');
  });
});
