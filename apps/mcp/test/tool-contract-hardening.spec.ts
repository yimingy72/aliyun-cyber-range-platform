import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PlatformApiClient, PlatformApiError } from '@aliyun-cyber-range/platform-api-client';
import { ADMIN_SCOPES } from '../src/auth';
import { createHttpApp } from '../src/http-app';
import { createToolRegistry } from '../src/server';

let server: ReturnType<typeof createHttpApp> | undefined;
let sdk: Client | undefined;
afterEach(async () => {
  await sdk?.close(); sdk = undefined;
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

async function connect(client: PlatformApiClient, scopes: string[], role?: 'admin' | 'user') {
  server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://fixture.invalid' }, {
    client, authenticateRequest: async () => ({ token: 'fixture-only', clientId: 'contract', scopes, extra: { role } }),
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  sdk = new Client({ name: 'tool-contract', version: '1' });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  return sdk;
}

describe('tool contract trust boundaries', () => {
  it('keeps all unknown top-level arguments out of the platform API, including harmless-looking selectors', async () => {
    const fetch = vi.fn();
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch });
    const registry = createToolRegistry(client);
    const tools = registry.listTools(ADMIN_SCOPES, 'admin');
    expect.soft(tools).toHaveLength(103);
    for (const tool of tools) {
      const parsed = tool.inputSchema.safeParse({ __unknownCallerField: true });
      expect(parsed.success, tool.name).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some(issue => issue.code === 'unrecognized_keys'), tool.name).toBe(true);
    }
    const sdk = await connect(client, ['ranges:control', 'instances:read', 'instances:credentials:read']);
    await sdk.listTools();
    for (const args of [{ cloudWorkspaceId: 'another-account' }, { defaultPassword: 'unexpected' }, { command: 'arbitrary' }]) {
      expect(await sdk.callTool({ name: 'range_instance_node_stop', arguments: { rangeInstanceId: 'range', nodeId: 'node', ...args } })).toMatchObject({ isError: true });
    }
    expect(await sdk.callTool({ name: 'single_instance_open_vnc', arguments: { singleInstanceId: 'single', description: 'not-a-pack' } })).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'user'] as const)('does not treat admin scopes as an admin role (%s)', async role => {
    const fetch = vi.fn();
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch });
    const registry = createToolRegistry(client);
    const names = registry.listTools(ADMIN_SCOPES, role).map(tool => tool.name);
    for (const name of ['admin_user_list', 'billing_summary_get', 'single_instance_network_destroy', 'cloud_config_update']) {
      expect(names).not.toContain(name);
      await expect(registry.callTool(name, ADMIN_SCOPES, {}, role)).rejects.toThrow('Forbidden tool');
    }
    const sdk = await connect(client, ADMIN_SCOPES, role);
    expect((await sdk.listTools()).tools.map(tool => tool.name)).not.toContain('billing_summary_get');
    expect(await sdk.callTool({ name: 'admin_user_create', arguments: { username: 'blocked', password: 'fixture-only', role: 'admin' } })).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires both instance-control and image-write authority before creating a packed image', async () => {
    const fetch = vi.fn();
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch }));
    for (const scopes of [['instances:control'], ['images:write']]) {
      expect(registry.listTools(scopes, 'admin').map(tool => tool.name)).not.toContain('single_instance_pack_image');
      await expect(registry.callTool('single_instance_pack_image', scopes, { singleInstanceId: 'single' }, 'admin')).rejects.toThrow('Forbidden tool');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards exact discard CAS and workspace headers through the HTTP SDK and returns platform conflicts', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'range/owned', draftRevision: 8, draftTopologyGraph: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 409, message: 'draft changed' }), { status: 409 }));
    const sdk = await connect(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-fixture', cloudWorkspaceId: 'space-a', fetch }), ['ranges:write']);
    await sdk.listTools();
    const args = { rangeInstanceId: 'range/owned', expectedDraftRevision: 7 };
    expect(await sdk.callTool({ name: 'range_instance_topology_discard', arguments: args })).toMatchObject({ structuredContent: { result: { id: 'range/owned', draftRevision: 8 } } });
    expect(await sdk.callTool({ name: 'range_instance_topology_discard', arguments: args })).toMatchObject({ isError: true, structuredContent: { result: { error: { statusCode: 409 } } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://fixture.invalid/admin/ranges/range%2Fowned/draft?expectedDraftRevision=7');
      expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer actor-fixture', 'x-cloud-workspace-id': 'space-a' } });
      expect(init.body).toBeUndefined();
    }
  });

  it('rejects half or reversed billing windows before any synchronization or export', async () => {
    const fetch = vi.fn();
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch }));
    for (const tool of registry.listTools(['billing:read', 'billing:sync'], 'admin')) {
      const target = tool.name === 'billing_user_summary_get' || tool.name === 'billing_user_item_list' || tool.name === 'billing_export_user_csv' ? { userId: 'user' } : {};
      for (const window of [{ startAt: '2026-10-10' }, { endAt: '2026-10-10' }, { startAt: '2026-10-11', endAt: '2026-10-10' }]) {
        await expect(registry.callTool(tool.name, tool.requiredScopes, { ...target, ...window }, 'admin')).rejects.toThrow('Invalid input');
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts access strings and nested default passwords from ordinary instance reads, while keeping network facts', async () => {
    const client = { getSingleInstance: vi.fn(async () => ({ id: 'single', accessEntry: { publicIp: '203.0.113.1', privateIp: '10.0.0.10', ssh: 'private-ssh' }, nested: { defaultPassword: 'private-default' }, runtimeCredentials: { host: { password: 'private-runtime' } } })) };
    const result = await createToolRegistry(client as never).callTool('single_instance_get', ['instances:read'], { singleInstanceId: 'single' });
    expect(result.structuredContent.result).toMatchObject({ accessEntry: { publicIp: '203.0.113.1', privateIp: '10.0.0.10' } });
    for (const secret of ['private-ssh', 'private-default', 'private-runtime']) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('exports only matching batch members via the credentials API and fails on denied access', async () => {
    const access = vi.fn().mockResolvedValueOnce({ runtimeCredentials: { host: { username: 'root', password: 'explicit-secret' } }, accessEntry: { publicIp: '203.0.113.2' } })
      .mockRejectedValueOnce(new PlatformApiError(403, 'access denied'));
    const client = { listSingleInstances: async () => ({ batches: [{ batch: { id: 'owned-batch', name: 'safe' }, instances: [{ id: 'owned', name: '=formula', runtimeCredentials: { host: { password: 'incidental-list-secret' } } }] }, { batch: { id: 'unrelated' }, instances: [{ id: 'other' }] }], standaloneInstances: [] }), getSingleInstanceAccess: access };
    const registry = createToolRegistry(client as never);
    const args = { batchId: 'owned-batch', view: 'active' };
    const scopes = ['instances:read', 'instances:credentials:read'];
    const result = await registry.callTool('single_instance_batch_export_csv', scopes, args);
    expect(result.structuredContent.result).toMatchObject({ rowCount: 1, csv: "实例名,公网 IP,账号,密码\n'=formula,203.0.113.2,root,explicit-secret" });
    expect(JSON.stringify(result)).not.toContain('incidental-list-secret');
    expect(access).toHaveBeenCalledWith('owned');
    expect(await registry.callTool('single_instance_batch_export_csv', scopes, args)).toMatchObject({ isError: true });
    expect(access.mock.calls.every(([id]) => id === 'owned')).toBe(true);
  });

  it('neutralizes spreadsheet formulas in every exported credential cell', async () => {
    const client = {
      listSingleInstances: async () => ({ batches: [{ batch: { id: 'formula-batch', name: 'formula' }, instances: [{ id: 'formula-instance', name: '+name' }] }], standaloneInstances: [] }),
      getSingleInstanceAccess: async () => ({ runtimeCredentials: { host: { username: '=user', password: '+1+1' } }, accessEntry: { publicIp: '=ip' } }),
    };
    const registry = createToolRegistry(client as never);
    const result = await registry.callTool('single_instance_batch_export_csv', ['instances:read', 'instances:credentials:read'], { batchId: 'formula-batch', view: 'active' });
    expect(result.structuredContent.result).toMatchObject({ rowCount: 1, csv: "实例名,公网 IP,账号,密码\n'+name,'=ip,'=user,'+1+1" });
  });
  it('does not reflect supplied credentials or unexpected nested credential fields in platform errors', async () => {
    const secret = 'SyntheticPrivatePassword1!';
    const registry = createToolRegistry({ createAdminUser: async () => { throw new PlatformApiError(400, 'invalid', { code: 'REJECTED', message: `Cannot accept ${secret}`, requestId: 'safe-request', nested: { accessKeySecret: 'server-private', password: secret } }); } } as never);
    const output = await registry.callTool('admin_user_create', ['users:write'], { username: 'fixture', password: secret, role: 'user' }, 'admin');
    expect(output).toMatchObject({ isError: true, structuredContent: { result: { error: { code: 'REJECTED', requestId: 'safe-request', message: 'Cannot accept [redacted]' } } } });
    for (const value of [secret, 'server-private']) expect(JSON.stringify(output)).not.toContain(value);
  });

  it('does not silently rebase a caller’s old whole-graph edit onto a newer template or runtime draft', async () => {
    const graph = { schemaVersion: '2.0.0', nodes: [
      { id: 'router', kind: 'router', label: 'Router' },
      { id: 'switch', kind: 'switch', label: 'Switch', zoneKey: 'zone', cidr: '10.0.0.0/24', purpose: 'private', aclRules: [], nat: { snatEnabled: false, dnatMappings: [] } },
      { id: 'host', kind: 'ecs', label: 'Host', zoneKey: 'zone', role: 'host', privateIp: '10.0.0.10', image: 'Image', imageId: 'image', platformImageAssetId: 'asset', imageStrategy: { mode: 'fixed', imageId: 'image' }, instanceTypeStrategy: { mode: 'auto' }, nics: [{ id: 'nic', switchId: 'switch', privateIp: '10.0.0.10' }] },
    ], edges: [{ id: 'router-switch', fromNodeId: 'router', toNodeId: 'switch', relationType: 'manual' }, { id: 'switch-host', fromNodeId: 'switch', toNodeId: 'host', relationType: 'manual' }] };
    const fetch = vi.fn(async (_url, init) => {
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({ id: 'owned', revision: 8, draftRevision: 8 }));
    });
    const sdk = await connect(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch }), ['ranges:write', 'templates:write']);
    await sdk.listTools();
    expect(await sdk.callTool({ name: 'range_instance_topology_save', arguments: { rangeInstanceId: 'owned', expectedDraftRevision: 7, topologyGraph: graph } })).toMatchObject({ isError: true });
    expect(await sdk.callTool({ name: 'range_template_topology_detect_and_save', arguments: { templateId: 'owned', expectedRevision: 7, topologyGraph: graph } })).toMatchObject({ isError: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://fixture.invalid/admin/ranges/owned', 'https://fixture.invalid/admin/scenarios/owned']);
  });

  it('passes the caller metadata revision directly and preserves backend conflicts without fetching a newer revision', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'template', name: 'New name', revision: 8 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 409, message: 'template changed' }), { status: 409 }));
    const sdk = await connect(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-only', fetch }), ['templates:write']);
    await sdk.listTools();
    const args = { templateId: 'template', expectedRevision: 7, updates: { name: 'New name' } };
    expect(await sdk.callTool({ name: 'range_template_update', arguments: args })).toMatchObject({ structuredContent: { result: { revision: 8 } } });
    expect(await sdk.callTool({ name: 'range_template_update', arguments: args })).toMatchObject({ isError: true, structuredContent: { result: { error: { statusCode: 409 } } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://fixture.invalid/admin/scenarios/template');
      expect(init).toMatchObject({ method: 'PATCH', body: JSON.stringify({ name: 'New name', expectedRevision: 7 }) });
    }
  });

});
