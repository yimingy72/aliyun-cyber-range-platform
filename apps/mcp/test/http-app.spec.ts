import { afterEach, describe, expect, it } from 'vitest';

import { createHttpApp } from '../src/http-app';

let server: ReturnType<typeof createHttpApp> | null = null;

afterEach(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe('http app', () => {
  it.each(['authentication', 'token exchange'])('returns an error and keeps serving after %s fails', async (stage) => {
    server = createHttpApp({
      host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.example',
    }, {
      authenticateRequest: async () => {
        if (stage === 'authentication') {
          throw new Error('Authentication service unavailable');
        }
        return { token: 'oidc-token', clientId: 'user-1', scopes: [], extra: { authType: 'oidc' } };
      },
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603 } });
    await expect(fetch(`${baseUrl}/healthz`).then((result) => result.json())).resolves.toEqual({ ok: true });
  });

  it('serves healthz', async () => {
    server = createHttpApp({
      host: '127.0.0.1',
      port: 0,
      platformApiBaseUrl: 'https://platform.example',
      platformApiToken: 'token-1',
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('rejects unauthenticated mcp requests', async () => {
    server = createHttpApp({
      host: '127.0.0.1',
      port: 0,
      platformApiBaseUrl: 'https://platform.example',
      platformApiToken: 'token-1',
    }, {
      authenticateRequest: async () => null,
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(401);
  });
});
