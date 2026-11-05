import { InstancePowerService } from '../../src/admin/instance-power.service';
import { InstancePowerCloudClient } from '../../src/admin/instance-power-cloud';
import { runInCloudWorkspace } from '../../src/auth/cloud-workspace-scope';
import type { PowerTarget } from '../../src/admin/instance-power-types';
import { createMemoryAdminRepository } from './create-memory-admin-repository';

export const scope = { cloudWorkspaceId: 'power-test-space', provider: 'alibaba_cloud' as const, accountUid: '100001' };
export const actor = { id: 'power-owner', role: 'user' as const };
export const context = { provider: scope.provider, cloudAccountContextId: 'power-context', cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', zoneId: 'cn-beijing-h' };
export const account = { provider: scope.provider, cloudAccountContextId: context.cloudAccountContextId, accountUid: scope.accountUid, accountUidResolved: true,
  defaultRegion: context.regionId, defaultZoneId: context.zoneId, accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
export const inSpace = <T>(work: () => Promise<T>) => runInCloudWorkspace(scope, work);

export async function fixture(mode: 'single' | 'range' = 'single', quantity = 1) {
  const repository = createMemoryAdminRepository();
  await repository.createPlatformUser({ id: actor.id, username: 'power-owner', passwordHash: 'fixture', role: 'user', status: 'active' });
  const batch = await repository.createSingleInstanceBatch({ name: 'power-batch', imageId: 'm-base', platformImageAssetId: 'asset', imageDisplayName: 'Base', cpu: 2, memory: 2, systemDiskSize: 40, quantity, ownerUserId: actor.id });
  const hosts: Record<string, any> = {};
  const instances = [];
  for (let index = 0; index < quantity; index++) {
    const id = 'i-original-' + index;
    const summary = { mode: mode === 'single' ? 'ecs-native' as const : 'opentofu' as const, executionContext: context, hostIds: { host: id },
      systemDiskIds: { host: 'd-original-' + index } };
    let row = await repository.createRangeInstance({ name: 'power-test-' + index, status: 'running', cloudProvider: scope.provider, instanceMode: mode,
      ownerUserId: actor.id, singleInstanceBatchId: mode === 'single' ? batch.id : null, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      resourceSummary: summary, runtimeTopologyGraph: { nodes: [{ id: 'host', kind: 'ecs', label: 'Node ' + index }] },
      accessEntry: { hostRole: 'host', privateIp: '10.0.10.10', publicIp: '192.0.2.1', ssh: 'ssh root@192.0.2.1' }, runtimeCredentials: { host: { username: 'root', password: 'NeverPrintThis9!' } } });
    const original = await repository.createProvisionJob({ rangeInstanceId: row.id, jobType: 'create', triggeredBy: actor.id });
    await repository.updateProvisionJob(original.id, { status: 'succeeded', startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() });
    if (mode === 'single') row = await repository.updateRangeInstance(row.id, { singleInstanceConfig: { executionBackend: 'ecs-native',
      cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: scope.accountUid, regionId: context.regionId, zoneId: context.zoneId,
      nativeCreateJobId: original.id, baseName: 'power-test', quantityIndex: index + 1, hostKey: 'host', hostName: 'host',
      platformImageAssetId: 'asset', imageId: 'm-base', imageDisplayName: 'Base', cpu: 2, memory: 2, systemDiskSize: 40 } });
    else {
      await repository.createProvisionJobStepLog({ jobId: original.id, stepName: 'range_resource_creation_receipt', status: 'succeeded', message: JSON.stringify({
        version: 1, rangeInstanceId: row.id, cloudWorkspaceId: scope.cloudWorkspaceId, sourceJobId: original.id, ownerUserId: actor.id, cloudProvider: scope.provider,
        executionContext: context, resources: [{ type: 'ecs', providerResourceType: 'alicloud_instance', address: 'module.range.alicloud_instance.hosts["host"]', id, logicalKey: 'host', action: 'create' }] }) });
      await repository.createProvisionJobStepLog({ jobId: original.id, stepName: 'range_resource_inventory', status: 'succeeded', message: JSON.stringify({ version: 1, rangeInstanceId: row.id, executionContext: context, resources: summary }) });
    }
    row = await repository.updateRangeInstance(row.id, { lastJobId: original.id });
    await repository.createBillingLedgerResource({ cloudProvider: scope.provider, cloudAccountUid: scope.accountUid, regionId: context.regionId, cloudResourceId: id,
      cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: actor.id, rangeInstanceId: row.id, singleInstanceBatchId: row.singleInstanceBatchId,
      sourceProvisionJobId: original.id, billingStartAt: new Date(Date.now() - 60_000) });
    const tags = { CreatedBy: 'cyber-range-platform', RangeInstanceId: row.id, PlatformUserId: actor.id, PlatformCreateJobId: original.id };
    hosts[id] = { InstanceId: id, InstanceType: 'ecs.e-c1m1.large', InstanceChargeType: 'PostPaid', InstanceNetworkType: 'vpc', Status: 'Running',
      AutoReleaseTime: new Date(Date.now() + 3900_000).toISOString(), InternetMaxBandwidthOut: 1, PublicIpAddress: { IpAddress: ['192.0.2.1'] },
      Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
      VpcAttributes: { VpcId: 'vpc-original', VSwitchId: 'vsw-original', PrivateIpAddress: { IpAddress: ['10.0.10.' + (10 + index)] } },
      SecurityGroupIds: { SecurityGroupId: ['sg-original'] }, NetworkInterfaces: { NetworkInterface: [{ NetworkInterfaceId: 'eni-original-' + index, PrimaryIpAddress: '10.0.10.' + (10 + index) }] } };
    instances.push(row);
  }
  const native = new InstancePowerCloudClient();
  const cloud = { verifyAccount: jest.fn(async () => undefined), assertEconomicalSupported: jest.fn(async () => undefined),
    host: jest.fn(async (_: any, id: string) => structuredClone(hosts[id])), disks: jest.fn(async (_: any, id: string) => [{ DiskId: 'd-original-' + id.split('-').at(-1), InstanceId: id, Type: 'system' }]),
    tags: native.tags.bind(native), networkDigest: native.networkDigest.bind(native), fact: native.fact.bind(native), runningReady: native.runningReady.bind(native),
    stopEconomical: jest.fn(async (_: any, id: string) => { hosts[id].Status = 'Stopped'; hosts[id].StoppedMode = 'StopCharging'; return { requestId: 'stop-receipt' }; }),
    start: jest.fn(async (_: any, id: string) => { hosts[id].Status = 'Running'; hosts[id].PublicIpAddress.IpAddress = ['192.0.2.2']; return { requestId: 'start-receipt' }; }) };
  const config = { getAccountContextById: jest.fn(async () => ({ ...account })), runInWorkspace: async <T>(_id: any, run: () => Promise<T>) => inSpace(run) };
  const service = new InstancePowerService(repository, config as any, cloud as any);
  const target: PowerTarget = { kind: mode, id: instances[0].id };
  const submit = async (action: 'economical_stop' | 'resume' = 'economical_stop', at?: string, to = target) => {
    const preview = await service.preview(to, action, actor, at);
    return service.submit(to, action, actor, preview.planDigest, at);
  };
  const claim = async (jobId: string) => {
    const job = await repository.claimProvisionJob(jobId, new Date()); if (!job) throw new Error('No claim'); return job;
  };
  return { repository, batch, instances, hosts, cloud, config, service, target, submit, claim };
}
