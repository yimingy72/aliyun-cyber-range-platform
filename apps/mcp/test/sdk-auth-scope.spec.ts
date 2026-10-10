import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createSdkServer } from '../src/sdk-server';

it('never restores constructor scopes when request auth explicitly has no scopes', async () => {
  const listRangeTemplates = vi.fn();
  const app = createServer(async (req, res) => {
    const server = createSdkServer({ listRangeTemplates } as never, ['templates:read'], 'user');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      (req as typeof req & { auth: AuthInfo }).auth = { token: 'fixture', clientId: 'fixture-client', scopes: [], extra: { role: 'user' } };
      await server.connect(transport); await transport.handleRequest(req, res);
    } finally { await transport.close(); await server.close(); }
  });
  const client = new Client({ name: 'scope-test', version: 'fixture' });
  try {
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.address() as import('node:net').AddressInfo).port}/mcp`)));
    expect(await client.callTool({ name: 'range_template_list', arguments: {} })).toMatchObject({ isError: true });
    expect(listRangeTemplates).not.toHaveBeenCalled();
  } finally {
    await client.close(); await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
});
