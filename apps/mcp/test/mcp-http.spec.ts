import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PlatformApiClient, PlatformApiError, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createHttpApp } from '../src/http-app';

type ClientStub = PlatformApiClientLike & {
  getInstanceTypeAvailability: ReturnType<typeof vi.fn>;
};

function createClientStub(): ClientStub {
  return {
    listRangeTemplates: vi.fn().mockResolvedValue([{ id: 'tpl-1' }]),
    getRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    createRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-2' }),
    updateRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    cloneRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-2' }),
    saveRangeTemplateTopology: vi.fn().mockResolvedValue({ id: 'tpl-1', revision: 2 }),
    publishRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    returnRangeTemplateToPrivate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    removeRangeTemplate: vi.fn().mockResolvedValue(undefined),
    listPlatformImages: vi.fn().mockResolvedValue([{ id: 'img-1' }]),
    listPlatformImageTags: vi.fn().mockResolvedValue([{ id: 'tag-1', name: 'Web' }]),
    createPlatformImageTag: vi.fn().mockResolvedValue({ id: 'tag-2', name: 'Service' }),
    setPlatformImageTags: vi.fn().mockResolvedValue({ id: 'img-1', tags: [] }),
    collectPlatformImage: vi.fn().mockResolvedValue({ id: 'img-2' }),
    renamePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', displayName: 'renamed' }),
    publishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'platform' }),
    unpublishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'private' }),
    enablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: true }),
    disablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: false }),
    removePlatformImage: vi.fn().mockResolvedValue(undefined),
    listImageCatalog: vi.fn().mockResolvedValue({ snapshots: [], catalogItems: [] }),
    syncImageCatalog: vi.fn().mockResolvedValue({ snapshots: [], catalogItems: [] }),
    removeCustomImageSnapshot: vi.fn().mockResolvedValue(undefined),
    listImageImportJobs: vi.fn().mockResolvedValue({ items: [] }),
    retryImageImport: vi.fn().mockResolvedValue({ id: 'import-1', status: 'importing' }),
    listRangeInstances: vi.fn().mockResolvedValue([{ id: 'range-1' }]),
    getRangeInstance: vi.fn().mockResolvedValue({ id: 'range-1' }),
    getRangeInstanceAccess: vi.fn().mockResolvedValue({ accessEntry: { publicIp: '1.1.1.1' } }),
    saveRangeInstanceDraft: vi.fn().mockResolvedValue({ id: 'range-1' }),
    applyRangeInstanceDraft: vi.fn().mockResolvedValue({ id: 'job-1' }),
    previewRangeInstanceDraft: vi.fn(),
    saveRangeInstanceAsTemplate: vi.fn(),
    syncRangeInstanceTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    retryRangeInstance: vi.fn().mockResolvedValue({ id: 'job-1' }),
    runRangeInstanceNodeAction: vi.fn().mockResolvedValue({ status: 'accepted' }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceCloudResourceStatus: vi.fn().mockResolvedValue({
      singleInstanceId: 'ins-1',
      regionId: 'cn-hangzhou',
      exists: false,
      instanceIds: [],
      checkedAt: '2026-07-29T00:00:00.000Z',
    }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ runtimeCredentials: {} }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    fetchCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud' }),
    saveCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou' }),
    listCloudAccountContexts: vi.fn().mockResolvedValue([]),
    listCloudWorkspaces: vi.fn().mockResolvedValue([]),
    getCurrentCloudWorkspace: vi.fn().mockResolvedValue({ id: 'fixture-ali-workspace', provider: 'alibaba_cloud', accountUid: '100001', isReadOnly: false, activeCloudAccountContextId: 'fixture-context', contexts: [{ id: 'fixture-context', provider: 'alibaba_cloud', accountUid: '100001', status: 'ready' }], capabilities: { provisioning: true, imageImport: true, billingSync: true } }),
    switchCloudWorkspace: vi.fn(),
    deleteCloudWorkspace: vi.fn(),
    saveCloudAccountBinding: vi.fn(),
    saveTencentCloudAccount: vi.fn(),
    discoverTencentCloudRegions: vi.fn(),
    listTencentCloudImages: vi.fn(),
    getCloudAccountInstanceTypeAvailability: vi.fn(),
    listAdminUsers: vi.fn().mockResolvedValue([{ id: 'user-1', username: 'alice' }]),
    createAdminUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'bob' }),
    updateAdminUserRole: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' }),
    updateAdminUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', status: 'disabled' }),
    resetAdminUserPassword: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice' }),
    getBillingSummary: vi.fn().mockResolvedValue({ totalPretaxAmount: 0 }),
    listBillingUsers: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
    getBillingUserSummary: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
    listBillingUserGroups: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
    listBillingPlatformGroups: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
    listBillingUserItems: vi.fn().mockResolvedValue([]),
    listBillingPlatformItems: vi.fn().mockResolvedValue([]),
    listBillingAnomalies: vi.fn().mockResolvedValue([]),
    syncBilling: vi.fn().mockResolvedValue({ syncedDays: 0, importedLineItems: 0, anomalyCount: 0, deferredCount: 0 }),
    exportPlatformBillingCsv: vi.fn().mockResolvedValue(''),
    exportBillingUsersCsv: vi.fn().mockResolvedValue(''),
    exportBillingUserItemsCsv: vi.fn().mockResolvedValue(''),
    launchRange: vi.fn().mockResolvedValue({ id: 'range-2' }),
    destroyRange: vi.fn().mockResolvedValue({ ok: true }),
    launchSingleInstances: vi.fn().mockResolvedValue({ batch: { id: 'batch-1' }, instances: [] }),
    destroySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    destroySingleInstanceBatch: vi.fn().mockResolvedValue({ batchId: 'batch-1', jobCount: 2 }),
    retrySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    rebootSingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    openSingleInstanceVnc: vi.fn().mockResolvedValue({ status: 'accepted', vncUrl: 'wss://vnc' }),
    packSingleInstanceImage: vi.fn().mockResolvedValue({ status: 'accepted', imageId: 'm-1' }),
    getInstanceTypeAvailability: vi.fn().mockResolvedValue({
      cpu: 2,
      memory: 4,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.e-c1m2.large', cpu: 2, memoryGiB: 4, family: 'ecs.e', generation: 'c1', architecture: 'x86' }],
      warning: null,
    }),
  } as ClientStub;
}

describe('mcp http e2e', () => {
  let server: ReturnType<typeof createHttpApp> | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
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
    server = null;
  });

  it('forwards each authenticated request workspace through the real HTTP gateway without retaining another client scope', async () => {
    const originalFetch = globalThis.fetch;
    const downstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://workspace-fixture.invalid')) return originalFetch(input, init);
      const scope = (init!.headers as Record<string, string>)['x-cloud-workspace-id'];
      return new Response(JSON.stringify({ items: [{ id: `image-${scope}`, displayName: `镜像 ${scope}` }] }));
    });
    vi.stubGlobal('fetch', downstream);
    server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://workspace-fixture.invalid' }, {
      resolvePlatformApiToken: async () => 'fixture-downstream-token',
      authenticateRequest: async () => ({ token: 'fixture-inbound-token', clientId: 'fixture', scopes: ['images:read'], extra: { role: 'user' } }),
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected bound HTTP server');
    for (const scope of ['space-a', 'space-b', 'space-a']) {
      const client = new Client({ name: scope, version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-inbound-token', 'x-cloud-workspace-id': scope } } }));
        expect(await client.callTool({ name: 'platform_image_list', arguments: {} })).toMatchObject({ structuredContent: { result: [{ id: `image-${scope}` }] } });
      } finally { await client.close(); }
    }
    const apiCalls = downstream.mock.calls.filter(([input]) => String(input).startsWith('https://workspace-fixture.invalid'));
    expect(apiCalls.map(([, init]) => (init!.headers as Record<string, string>)['x-cloud-workspace-id'])).toEqual(['space-a', 'space-b', 'space-a']);
    expect(apiCalls.every(([, init]) => (init!.headers as Record<string, string>).Authorization === 'Bearer fixture-downstream-token')).toBe(true);
  });

  it('passes the authenticated user role into image tool discovery and rejects hidden admin tools', async () => {
    const platformClient = createClientStub();
    const auth: AuthInfo = { token: 'user-token', clientId: 'owner', scopes: ['images:read', 'images:write'], extra: { role: 'user' } };
    server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.example', }, { authenticateRequest: async () => auth, client: platformClient });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected server address');
    const client = new Client({ name: 'role-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer user-token' } } }));
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('platform_image_tag_list'); expect(names).toContain('platform_image_tags_set');
      for (const name of ['platform_image_tag_create', 'platform_image_collect', 'platform_image_publish', 'platform_image_unpublish']) expect(names).not.toContain(name);
      await expect(client.callTool({ name: 'platform_image_tag_create', arguments: { name: 'blocked' } })).resolves.toMatchObject({ isError: true });
      expect(platformClient.createPlatformImageTag).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it('preserves platform query failures through the SDK output validator', async () => {
    const platformClient = createClientStub();
    const details = { statusCode: 400, error: 'Bad Request', message: '阿里云可售机型查询失败（HTTP 404，InvalidRegionId.NotFound）。' };
    vi.mocked(platformClient.getCloudAccountInstanceTypeAvailability).mockRejectedValue(new PlatformApiError(400, details.message, details));
    server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.example', }, {
      authenticateRequest: async () => ({ token: 'fixture-inbound-token', clientId: 'fixture', scopes: ['settings:read'], extra: { role: 'admin' } }), client: platformClient,
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected bound HTTP server');
    const client = new Client({ name: 'platform-query-error', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-inbound-token' } } }));
      await client.listTools();
      const result = await client.callTool({ name: 'cloud_account_instance_type_availability', arguments: { cloudAccountContextId: 'context-beijing', cpu: 2, memory: 4 } });
      expect(result).toMatchObject({ isError: true, structuredContent: { result: { error: details } } });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ result: { error: details } }, null, 2) }]);
      expect(platformClient.getCloudAccountInstanceTypeAvailability).toHaveBeenCalledWith('context-beijing', 2, 4);
    } finally { await client.close(); }
  });

  it('delivers a confirmation challenge and accepts only the explicitly confirmed retry', async () => {
    const platformClient = createClientStub();
    const challenge = { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation-platform', idempotencyKey: 'stable-idempotency', summary: { targetName: 'fixture-range', createsCloudResources: true } };
    vi.mocked(platformClient.launchRange).mockRejectedValueOnce(new PlatformApiError(409, 'confirmation required', challenge)).mockResolvedValueOnce({ id: 'fixture-range' } as never);
    server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://platform.example', }, {
      authenticateRequest: async () => ({ token: 'fixture-inbound-token', clientId: 'fixture', scopes: ['ranges:create'], extra: { role: 'admin' } }), client: platformClient,
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected bound HTTP server');
    const client = new Client({ name: 'platform-confirmation', version: '1.0.0' });
    const args = { templateId: 'fixture-template', name: 'fixture-range', expiresAt: '2027-01-01T00:00:00.000Z', idempotencyKey: challenge.idempotencyKey };
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-inbound-token' } } }));
      await client.listTools();
      expect(await client.callTool({ name: 'range_instance_launch', arguments: args })).toMatchObject({ isError: true, structuredContent: { result: { error: challenge } } });
      expect(platformClient.launchRange).toHaveBeenCalledTimes(1);
      expect(await client.callTool({ name: 'range_instance_launch', arguments: { ...args, confirmationId: challenge.confirmationId } })).toMatchObject({ structuredContent: { result: { id: 'fixture-range' } } });
      expect(platformClient.launchRange).toHaveBeenNthCalledWith(2, { templateId: args.templateId, name: args.name, expiresAt: args.expiresAt }, { idempotencyKey: challenge.idempotencyKey, confirmationId: challenge.confirmationId });
    } finally { await client.close(); }
  });

  it('lists scoped tools and calls one tool over streamable http', async () => {
    const platformClient = createClientStub();
    const auth: AuthInfo = {
      token: 'token-1',
      clientId: 'alice',
      scopes: ['templates:read', 'instances:read'],
    };

    server = createHttpApp(
      {
        host: '127.0.0.1',
        port: 0,
        platformApiBaseUrl: 'https://platform.example',
      },
      {
        authenticateRequest: async () => auth,
        client: platformClient,
      },
    );

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }

    const appClient = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: 'Bearer token-1',
        },
      },
    });

    await appClient.connect(transport);

    const tools = await appClient.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain('range_template_list');
    expect(tools.tools.map((tool) => tool.name)).toContain('single_instance_get');
    expect(tools.tools.map((tool) => tool.name)).toContain('single_instance_cloud_resource_status');
    const specTool = tools.tools.find((tool) => tool.name === 'single_instance_spec_check');

    expect(specTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        cpu: { type: 'integer' },
        memory: { type: 'integer' },
      },
      required: ['cpu', 'memory'],
    });
    expect(tools.tools.map((tool) => tool.name)).not.toContain('single_instance_destroy');

    const result = await appClient.callTool({
      name: 'single_instance_get',
      arguments: {
        singleInstanceId: 'ins-1',
      },
    });

    expect(platformClient.getSingleInstance).toHaveBeenCalledWith('ins-1');
    expect(result.structuredContent).toEqual({ result: { id: 'ins-1' } });

    const specificationResult = await appClient.callTool({
      name: 'single_instance_spec_check',
      arguments: { cpu: 2, memory: 4 },
    });

    expect(platformClient.getInstanceTypeAvailability).toHaveBeenCalledWith(2, 4);
    expect(specificationResult.structuredContent).toMatchObject({ result: { exactAvailable: true } });

    await transport.close();
    await appClient.close();
  });

  it('returns the published template after a confirmed publish response', async () => {
    const platformClient = new PlatformApiClient({
      baseUrl: 'https://platform.example',
      token: 'token-1',
      fetch: vi.fn(async (input: string) => {
        if (input.endsWith('/admin/scenarios/tpl-1')) {
          return new Response(JSON.stringify({ id: 'tpl-1', revision: 1 }), { status: 200 });
        }

        if (input.endsWith('/admin/scenarios/tpl-1/share')) {
          return new Response(
            JSON.stringify({
              operationId: 'operation-publish-1',
              result: {
                result: {
                  id: 'tpl-1',
                  visibility: 'platform',
                  status: 'published',
                  revision: 2,
                },
              },
            }),
            { status: 200 },
          );
        }

        throw new Error(`Unexpected platform request: ${input}`);
      }) as typeof fetch,
    });
    const auth: AuthInfo = {
      token: 'token-1',
      clientId: 'alice',
      scopes: ['templates:read', 'templates:publish'],
    };

    server = createHttpApp(
      {
        host: '127.0.0.1',
        port: 0,
        platformApiBaseUrl: 'https://platform.example',
      },
      {
        authenticateRequest: async () => auth,
        client: platformClient,
      },
    );

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }

    const appClient = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: 'Bearer token-1',
        },
      },
    });

    await appClient.connect(transport);

    const result = await appClient.callTool({
      name: 'range_template_publish',
      arguments: {
        templateId: 'tpl-1',
        confirmationId: 'confirmation-1',
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      result: {
        id: 'tpl-1',
        visibility: 'platform',
        status: 'published',
        revision: 2,
      },
    });

    await transport.close();
    await appClient.close();
  });
});
