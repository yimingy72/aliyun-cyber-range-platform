import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import * as cloud from '../src/admin/tencent-cloud-resources';
import * as rpc from '../src/admin/tencent-cloud-client';
import { retiredResourceInventory } from '../src/provisioning/retired-resource-inventory';

afterEach(() => jest.restoreAllMocks());

it('completes a detached Tencent range, destroys in its frozen account and retains the seven released fee identities', async () => {
  const repository = createMemoryAdminRepository();
  const account = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'source-context', accountUid: '100000000001', accountUidResolved: true,
    defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
  const template = await repository.createRangeTemplate({ name: 'Detached Tencent range', slug: 'detached-tencent', version: 'v1', cloudProvider: 'tencent_cloud',
    modulePathOrRef: 'infra/opentofu/modules/tencentcloud-enterprise-range', topologySpec: { vpcCidr: '10.0.0.0/16',
      networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'entry', cidr: '10.0.1.0/24' }],
      hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.10' }, { key: 'internal', name: 'Internal', zoneKey: 'dmz', role: 'server', privateIp: '10.0.1.20' }],
      publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] } } });
  const original = await repository.createRangeInstance({ name: 'Detached fixture', instanceMode: 'range', cloudProvider: 'tencent_cloud', ownerUserId: 'alice',
    templateId: template.id, status: 'pending_create', allocatedCidr: '10.0.0.0/16' });
  const createJob = await repository.createProvisionJob({ rangeInstanceId: original.id, jobType: 'create', triggeredBy: 'alice' });
  await repository.updateRangeInstance(original.id, { lastJobId: createJob.id });
  const summary = { mode: 'opentofu' as const, hostIds: { entry: 'ins-entry', internal: 'ins-internal' }, systemDiskIds: { entry: 'disk-entry', internal: 'disk-internal' },
    natGatewayIds: { shared: 'nat-owned' }, eipAllocationIds: { snat: 'eip-snat', dnat: 'eip-dnat' } };
  let present = true;
  const selected = { value: account };
  const system = { getExecutionAccountContext: jest.fn(async (options?: { cloudAccountContextId?: string | null }) => {
    if (options) { expect(options.cloudAccountContextId).toBe(account.cloudAccountContextId); return account; }
    return selected.value;
  }) };
  const provisioner = { mode: 'opentofu' as const,
    create: jest.fn(async (input: any) => {
      await input.onApplyStart();
      expect(input.billingTags).toMatchObject({ CloudProvider: 'tencent_cloud', PlatformCreateJobId: createJob.id, CloudAccountUid: account.accountUid });
      expect(await repository.getRangeInstanceById(original.id)).toMatchObject({ resourceSummary: { creationAttempted: true, executionContext: { provider: 'tencent_cloud' } } });
      expect(original.resourceSummary).toBeNull();
      return { accessEntry: { hostRole: 'entry', publicIp: '203.0.113.1', privateIp: '10.0.1.10', ssh: null }, resourceSummary: summary };
    }),
    inspectResources: jest.fn(async () => summary),
    destroy: jest.fn(async (input: any) => { expect(input.runtimeConfig).toEqual(account); present = false; }),
  };
  const queries = jest.spyOn(cloud, 'describeTencentResourceInventory').mockImplementation(async (context, kind, query: any) => {
    expect(context).toMatchObject(account);
    if (kind === 'disk' && query.instanceId && present) return [{ id: query.instanceId === 'ins-entry' ? 'disk-entry' : 'disk-internal',
      tags: {}, instanceId: query.instanceId, diskUsage: 'SYSTEM_DISK', deleteWithInstance: true, shared: false }] as any;
    return [];
  });
  jest.spyOn(rpc, 'requestTencentCloud').mockImplementation(async input => {
    if (input.action !== 'DescribeDisks') throw new Error('Unexpected synthetic cloud query');
    const hostId = (input.parameters as any).Filters?.find((filter: any) => filter.Name === 'instance-id')?.Values[0];
    return { RequestId: 'fixture-disk-request', TotalCount: present ? 1 : 0, DiskSet: present ? [{ DiskId: hostId === 'ins-entry' ? 'disk-entry' : 'disk-internal',
      InstanceId: hostId, DiskUsage: 'SYSTEM_DISK', DeleteWithInstance: true, Shareable: false, DiskChargeType: 'POSTPAID_BY_HOUR' }] : [] } as any;
  });
  const worker = new ProvisioningWorkerService(repository, provisioner as any, system as any);
  await worker.process(createJob.id);
  expect(await repository.getProvisionJobById(createJob.id)).toMatchObject({ status: 'succeeded', errorSummary: null });
  expect(await repository.getRangeInstanceById(original.id)).toMatchObject({ status: 'running', resourceSummary: { ...summary,
    executionContext: { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId } } });
  const createdRows = await repository.listBillingLedgerResources({ rangeInstanceId: original.id });
  expect(createdRows).toHaveLength(7);
  expect(createdRows.every(row => row.cloudProvider === 'tencent_cloud' && row.ownerUserId === 'alice' && row.sourceProvisionJobId === createJob.id && !row.releasedAt)).toBe(true);
  const creationInventory = (await repository.listProvisionJobStepLogs(createJob.id)).filter(log => log.stepName === 'platform_billing_creation_inventory');
  expect(creationInventory.length).toBeGreaterThan(0);
  selected.value = { ...account, cloudAccountContextId: 'other-context', accountUid: '200000000001' };
  const destroyJob = await repository.createProvisionJob({ rangeInstanceId: original.id, jobType: 'destroy', triggeredBy: 'alice' });
  await repository.updateRangeInstance(original.id, { status: 'pending_destroy', lastJobId: destroyJob.id });
  await worker.process(destroyJob.id);
  expect((await repository.getProvisionJobById(destroyJob.id))?.status).toBe('succeeded');
  const destroyed = await repository.getRangeInstanceById(original.id);
  expect(destroyed?.status).toBe('destroyed');
  expect(destroyed?.resourceSummary).toEqual({ mode: 'opentofu', creationAttempted: false,
    executionContext: { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId,
      cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId } });
  const released = await repository.listBillingLedgerResources({ rangeInstanceId: original.id });
  expect(released.map(row => row.id)).toEqual(createdRows.map(row => row.id));
  expect(released.every(row => row.releasedAt)).toBe(true);
  expect(await repository.listProvisionJobStepLogs(createJob.id)).toEqual(expect.arrayContaining(creationInventory));
  expect(queries.mock.calls.some(([, kind, query]) => kind === 'nat' && query.ids?.includes('nat-owned'))).toBe(true);
  expect(queries.mock.calls.some(([, kind, query]) => kind === 'eip' && query.ids?.includes('eip-dnat'))).toBe(true);
});

it('keeps the original execution identity for retired Tencent IDs and never guesses it from a replacement snapshot', async () => {
  const context = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'source-context', cloudAccountUid: '100000000001', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2' };
  const account = { provider: context.provider, cloudAccountContextId: context.cloudAccountContextId, accountUid: context.cloudAccountUid, accountUidResolved: true,
    defaultRegion: context.regionId, defaultZoneId: context.zoneId, accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
  const before = { mode: 'opentofu' as const, executionContext: context, hostIds: { entry: 'ins-retired' }, systemDiskIds: { entry: 'disk-retired' },
    eipAllocationIds: { entry: 'eip-retired' }, natGatewayIds: { shared: 'nat-retired' } };
  const replacement = { mode: 'opentofu' as const, executionContext: { ...context, cloudAccountContextId: 'other-context' }, hostIds: { entry: 'ins-new' } };
  const retired = retiredResourceInventory(before, replacement)!;
  expect(retired.executionContext).toEqual(context);
  const queries = jest.spyOn(cloud, 'describeTencentResourceInventory').mockResolvedValue([]);
  const worker = new ProvisioningWorkerService({} as any, {} as any, {} as any) as any;
  await expect(worker.findResidualCloudResources(retired, account)).resolves.toEqual([]);
  expect(queries.mock.calls.map(([, kind]) => kind).sort()).toEqual(['disk', 'ecs', 'eip', 'nat']);
  const unbound = retiredResourceInventory({ ...before, executionContext: undefined }, replacement)!;
  expect(unbound.executionContext).toBeUndefined();
  queries.mockClear();
  await expect(worker.findResidualCloudResources(unbound, account)).rejects.toThrow('frozen execution identity');
  expect(queries).not.toHaveBeenCalled();
  await expect(worker.findResidualCloudResources({ mode: 'opentofu', executionContext: context, retiredResources: unbound }, account)).rejects.toThrow('original frozen execution identity');
  expect(queries).not.toHaveBeenCalled();
});
