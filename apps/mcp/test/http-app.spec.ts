import { afterEach, describe, expect, it } from 'vitest';

import { createHttpApp } from '../src/http-app';
import { request as httpRequest } from 'node:http';

let server: ReturnType<typeof createHttpApp> | null = null;

afterEach(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      server = null;
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
    expect(response.status).toBe(stage === 'authentication' ? 500 : 401);
    const body = await response.json();
    expect(body.error.code).toBe(stage === 'authentication' ? -32603 : -32001);
    expect(JSON.stringify(body)).not.toContain('Authentication service unavailable');
    await expect(fetch(`${baseUrl}/healthz`).then((result) => result.json())).resolves.toEqual({ ok: true });
  });

  it('serves healthz', async () => {
    server = createHttpApp({
      host: '127.0.0.1',
      port: 0,
      platformApiBaseUrl: 'https://platform.example',
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
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
  });
});

describe('HTTP trust boundary', () => {
  async function start() {
    server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.invalid', publicUrl: 'https://mcp.example/mcp', oidcIssuer: 'https://issuer.example' }, {
      authenticateRequest: async () => null,
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}`;
  }
  it('rejects hostile Origin including opaque null', async () => {
    const base = await start();
    for (const origin of ['https://evil.invalid', 'null', 'https://mcp.example.evil.invalid']) {
      expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: origin } })).status).toBe(403);
    }
  });
  it('rejects a rebound Host even when forwarded host is trusted', async () => {
    const base = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/mcp`, { method: 'POST', headers: { Host: 'evil.invalid', 'X-Forwarded-Host': 'mcp.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });
  it('rejects duplicate authorization headers', async () => {
    const base = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/mcp`, { method: 'POST', headers: { Authorization: ['Bearer first', 'Bearer second'] } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });
  it('accepts absent and exactly configured Origin and advertises metadata', async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Host: 'mcp.example', Origin: 'https://mcp.example' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"');
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()).toEqual({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://issuer.example'], bearer_methods_supported: ['header'] });
  });
  it('does not accept malformed configured public URLs', () => {
    for (const publicUrl of ['https://user:password@mcp.example/mcp', 'https://mcp.example/mcp?secret=token', 'https://mcp.example/other']) {
      expect(() => createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.invalid', publicUrl })).toThrow('MCP_PUBLIC_URL');
    }
  });
});
