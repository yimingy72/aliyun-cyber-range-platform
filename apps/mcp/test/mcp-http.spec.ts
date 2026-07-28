import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PlatformApiClient, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

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
    syncRangeInstanceTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    retryRangeInstance: vi.fn().mockResolvedValue({ id: 'job-1' }),
    removeFailedRangeInstance: vi.fn().mockResolvedValue(undefined),
    runRangeInstanceNodeAction: vi.fn().mockResolvedValue({ status: 'accepted' }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ runtimeCredentials: {} }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    fetchCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud' }),
    saveCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou' }),
    listAdminUsers: vi.fn().mockResolvedValue([{ id: 'user-1', username: 'alice' }]),
    createAdminUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'bob' }),
    updateAdminUserRole: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' }),
    updateAdminUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', status: 'disabled' }),
    resetAdminUserPassword: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice' }),
    getBillingSummary: vi.fn().mockResolvedValue({ totalPretaxAmount: 0 }),
    listBillingUsers: vi.fn().mockResolvedValue([]),
    getBillingUserSummary: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
    listBillingUserGroups: vi.fn().mockResolvedValue([]),
    listBillingPlatformGroups: vi.fn().mockResolvedValue([]),
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
        platformApiToken: 'token-1',
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
        platformApiToken: 'token-1',
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
