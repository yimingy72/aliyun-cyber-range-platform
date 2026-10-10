import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { users } = vi.hoisted(() => ({ users: new Map<string, { id: string; username: string; role: 'admin' | 'user'; status: string; cloudWorkspaceId: string; isPlatformManager: boolean }>() }));
vi.mock('@aliyun-cyber-range/database/generated/client', () => ({ PrismaClient: class { platformUser = { findFirst: async ({ where }: { where: { oidcSubject: string; status: string } }) => {
  const user = users.get(where.oidcSubject); return user?.status === where.status ? user : null;
} }; } }));
import { createHttpApp } from '../src/http-app';

it('isolates signed identities, workspace selection and current roles for clients sharing an OAuth client ID', async () => {
  const env = { ...process.env };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  let issuer = '';
  const sign = (subject: string, aud: string, azp: string) => {
    const data = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' })}.${encode({ iss: issuer, sub: subject, aud, azp, typ: 'Bearer', exp: Math.floor(Date.now() / 1000) + 300, scope: 'openid profile' })}`;
    const signer = createSign('RSA-SHA256'); signer.update(data); signer.end(); return `${data}.${signer.sign(pair.privateKey).toString('base64url')}`;
  };
  const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string; aud: string; azp: string };
  const calls: Array<{ subject: string; workspace: string | undefined; azp: string; aud: string }> = [];
  const exchanges: string[] = [];
  const fixture = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] })); return; }
    if (req.url === '/token') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = new URLSearchParams(raw); const subject = decode(input.get('subject_token')!).sub;
      exchanges.push(subject); res.end(JSON.stringify({ access_token: sign(subject, 'platform-api', 'mcp-gateway'), token_type: 'Bearer' })); return;
    }
    if (req.url?.startsWith('/admin/scenarios')) {
      const token = req.headers.authorization!.slice(7); const claims = decode(token);
      calls.push({ subject: claims.sub, aud: claims.aud, azp: claims.azp, workspace: req.headers['x-cloud-workspace-id'] as string | undefined });
      res.end(JSON.stringify([{ id: `template-${claims.sub}-${req.headers['x-cloud-workspace-id']}` }])); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  let gateway: ReturnType<typeof createHttpApp> | undefined;
  try {
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    issuer = `http://127.0.0.1:${(fixture.address() as import('node:net').AddressInfo).port}`;
    process.env.OIDC_ISSUER = issuer; process.env.OIDC_JWKS_URL = `${issuer}/jwks`; process.env.MCP_OIDC_AUDIENCE = 'mcp-gateway';
    users.set('alice', { id: 'user-alice', username: 'alice', role: 'admin', status: 'active', cloudWorkspaceId: 'space-a', isPlatformManager: true });
    users.set('bob', { id: 'user-bob', username: 'bob', role: 'user', status: 'active', cloudWorkspaceId: 'space-b', isPlatformManager: false });
    gateway = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: issuer, oidcIssuer: issuer, oidcTokenEndpoint: `${issuer}/token`, oidcClientId: 'mcp-gateway', oidcClientSecret: 'fixture-only' });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    const url = new URL(`http://127.0.0.1:${(gateway.address() as import('node:net').AddressInfo).port}/mcp`);
    const run = async (subject: string, workspace: string) => {
      const client = new Client({ name: subject, version: 'fixture' });
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${sign(subject, 'mcp-gateway', 'shared-frontend')}`, 'x-cloud-workspace-id': workspace } } }));
        const names = (await client.listTools()).tools.map(tool => tool.name);
        const result = await client.callTool({ name: 'range_template_list', arguments: {} });
        return { names, result };
      } finally { await client.close(); }
    };
    expect((await run('alice', 'space-a')).names).toContain('admin_user_list');
    expect((await run('bob', 'space-b')).names).not.toContain('admin_user_list');
    users.get('alice')!.role = 'user';
    expect((await run('alice', 'space-c')).names).not.toContain('admin_user_list');
    expect(calls).toEqual([
      { subject: 'alice', workspace: 'space-a', azp: 'mcp-gateway', aud: 'platform-api' },
      { subject: 'bob', workspace: 'space-b', azp: 'mcp-gateway', aud: 'platform-api' },
      { subject: 'alice', workspace: 'space-c', azp: 'mcp-gateway', aud: 'platform-api' },
    ]);
    expect(exchanges).toContain('alice'); expect(exchanges).toContain('bob');
    users.get('alice')!.status = 'disabled';
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${sign('alice', 'mcp-gateway', 'shared-frontend')}` } });
    expect(response.status).toBe(401); expect(calls).toHaveLength(3);
  } finally {
    users.clear(); process.env = env;
    for (const server of [gateway, fixture]) if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
