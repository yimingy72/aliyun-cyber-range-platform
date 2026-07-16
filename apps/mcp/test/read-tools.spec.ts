import { describe, expect, it, vi } from 'vitest';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createToolRegistry } from '../src/server';

function createClientStub(): PlatformApiClientLike {
  return {
    listRangeTemplates: vi.fn().mockResolvedValue([{ id: 'tpl-1' }]),
    getRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    listPlatformImages: vi.fn().mockResolvedValue([{ id: 'img-1' }]),
    collectPlatformImage: vi.fn().mockResolvedValue({ id: 'img-2' }),
    renamePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', displayName: 'renamed' }),
    publishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'platform' }),
    unpublishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'private' }),
    enablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: true }),
    disablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: false }),
    removePlatformImage: vi.fn().mockResolvedValue(undefined),
    listRangeInstances: vi.fn().mockResolvedValue([{ id: 'range-1' }]),
    getRangeInstance: vi.fn().mockResolvedValue({ id: 'range-1' }),
    getRangeInstanceAccess: vi.fn().mockResolvedValue({ accessEntry: { publicIp: '1.1.1.1' } }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [{ batch: { id: 'batch-1', name: 'batch-a' }, instances: [{ id: 'ins-1', name: 'ins-1', accessEntry: { publicIp: '1.1.1.1' }, runtimeCredentials: { 'single-ecs-1': { username: 'root', password: 'secret' } }, singleInstanceConfig: { hostKey: 'single-ecs-1', imageDisplayName: 'Ubuntu 24.04' } }] }], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ defaultInstancePassword: 'secret' }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    fetchCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud' }),
    saveCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou' }),
    listAdminUsers: vi.fn().mockResolvedValue([{ id: 'user-1', username: 'alice' }]),
    createAdminUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'bob' }),
    updateAdminUserRole: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' }),
    updateAdminUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', status: 'disabled' }),
    resetAdminUserPassword: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice' }),
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

describe('tool registry', () => {
  it('filters tools by scopes', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools(['templates:read', 'instances:read']);

    expect(tools.map((tool) => tool.name)).toContain('range_template_list');
    expect(tools.map((tool) => tool.name)).toContain('single_instance_get');
    expect(tools.map((tool) => tool.name)).not.toContain('single_instance_destroy');
  });

  it('maps mutation tools to client calls', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_instance_launch', ['ranges:create'], {
      templateId: 'tpl-1',
      name: 'range-a',
      expiresAt: '2026-07-20T00:00:00.000Z',
      idempotencyKey: 'idem-1',
      confirmationId: 'confirm-1',
    });

    expect(client.launchRange).toHaveBeenCalledWith(
      { templateId: 'tpl-1', name: 'range-a', expiresAt: '2026-07-20T00:00:00.000Z' },
      { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' },
    );
  });

  it('opens vnc without confirmation fields', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    const result = await registry.callTool('single_instance_open_vnc', ['instances:control', 'instances:credentials:read'], {
      singleInstanceId: 'ins-1',
    });

    expect(client.openSingleInstanceVnc).toHaveBeenCalledWith('ins-1', {
      displayName: undefined,
      defaultHostName: undefined,
      defaultPassword: undefined,
      description: undefined,
    });
    expect(result.structuredContent).toEqual({ status: 'accepted', vncUrl: 'wss://vnc' });
  });

  it('exports a single instance batch as csv', async () => {
    const registry = createToolRegistry(createClientStub());

    const result = await registry.callTool('single_instance_batch_export_csv', ['instances:read', 'instances:credentials:read'], {
      batchId: 'batch-1',
    });

    expect(result.structuredContent).toEqual({
      batchId: 'batch-1',
      batchName: 'batch-a',
      fileName: 'batch-a-instances.csv',
      rowCount: 1,
      csv: '实例名,公网 IP,账号,密码\nins-1,1.1.1.1,root,secret',
    });
  });
});
