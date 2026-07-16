import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createHttpApp } from '../src/http-app';

function createClientStub(): PlatformApiClientLike {
  return {
    listRangeTemplates: vi.fn().mockResolvedValue([{ id: 'tpl-1' }]),
    getRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    listPlatformImages: vi.fn().mockResolvedValue([{ id: 'img-1' }]),
    listRangeInstances: vi.fn().mockResolvedValue([{ id: 'range-1' }]),
    getRangeInstance: vi.fn().mockResolvedValue({ id: 'range-1' }),
    getRangeInstanceAccess: vi.fn().mockResolvedValue({ accessEntry: { publicIp: '1.1.1.1' } }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ defaultInstancePassword: 'secret' }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    launchRange: vi.fn().mockResolvedValue({ id: 'range-2' }),
    destroyRange: vi.fn().mockResolvedValue({ ok: true }),
    launchSingleInstances: vi.fn().mockResolvedValue({ batch: { id: 'batch-1' }, instances: [] }),
    destroySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    destroySingleInstanceBatch: vi.fn().mockResolvedValue({ batchId: 'batch-1', jobCount: 2 }),
    retrySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    rebootSingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    openSingleInstanceVnc: vi.fn().mockResolvedValue({ status: 'accepted', vncUrl: 'wss://vnc' }),
    packSingleInstanceImage: vi.fn().mockResolvedValue({ status: 'accepted', imageId: 'm-1' }),
  };
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
    expect(tools.tools.map((tool) => tool.name)).not.toContain('single_instance_destroy');

    const result = await appClient.callTool({
      name: 'single_instance_get',
      arguments: {
        singleInstanceId: 'ins-1',
      },
    });

    expect(platformClient.getSingleInstance).toHaveBeenCalledWith('ins-1');
    expect(result.structuredContent).toEqual({ id: 'ins-1' });

    await transport.close();
    await appClient.close();
  });
});
