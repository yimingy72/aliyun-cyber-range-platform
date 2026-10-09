import type { AdminRepository } from '../src/admin/admin.repository';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function createLaunchFixture() {
  const repository = createMemoryAdminRepository();
  const account = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'context-1', accountUid: 'account-1', accountUidResolved: true,
    defaultRegion: 'cn-test', defaultZoneId: 'cn-test-a', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: 'synthetic-bucket' };
  const image = { id: 'asset-1', enabled: true, visibility: 'platform', provider: account.provider,
    accountUid: account.accountUid, regionId: account.defaultRegion, sourceSnapshotId: 'source-1', imageId: 'm-fixture', displayName: 'Ubuntu', defaultHostName: null };
  const source = { id: 'source-1', isAvailable: true, osType: 'linux' };
  jest.spyOn(repository, 'getPlatformImageAssetById').mockImplementation(async () => ({ ...image }) as never);
  jest.spyOn(repository, 'getImageSnapshotById').mockImplementation(async () => ({ ...source }) as never);
  const availability = { exactAvailable: true, matches: [{ instanceTypeId: 'ecs.fixture' }], warning: null };
  const config = { getAccountContext: jest.fn().mockImplementation(async () => ({ ...account })),
    getInstanceTypeAvailabilityInContext: jest.fn().mockResolvedValue(availability) };
  let inControlLock = false;
  const controlLock = repository.withSingleInstanceControlLock.bind(repository);
  jest.spyOn(repository, 'withSingleInstanceControlLock').mockImplementation(work => controlLock(async () => {
    inControlLock = true;
    try { return await work(); } finally { inControlLock = false; }
  }));
  const profile = { id: 'network-1', provider: account.provider, cloudAccountUid: account.accountUid, regionId: account.defaultRegion,
    zoneId: account.defaultZoneId, vpcId: 'vpc-fixture', vpcCidr: '10.200.0.0/16', vswitchIds: ['vsw-1', 'vsw-2', 'vsw-3'],
    vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'], securityGroupId: 'sg-fixture' };
  jest.spyOn(repository, 'getSingleInstanceNetworkProfileById').mockResolvedValue(profile as never);
  const network = { ensureDefaultProfile: jest.fn().mockImplementation(async () => {
    expect(inControlLock).toBe(true);
    return profile;
  }), allocateVswitch: SingleInstanceNetworkService.prototype.allocateVswitch };
  const execution = { resolveInstanceAccount: jest.fn().mockResolvedValue(account) };
  const worker = { dispatch: jest.fn() };
  const service = new SingleInstancesService(repository, config as unknown as SystemConfigService,
    network as unknown as SingleInstanceNetworkService, execution as unknown as SingleInstanceBatchExecutionService,
    worker as unknown as ProvisioningWorkerService, {} as RangeInstanceNodeActionsService);
  const input = { name: 'queued-single', platformImageAssetId: image.id, cpu: 2, memory: 2, quantity: 2,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  const actor = { id: 'user-1', role: 'user' as const, username: 'fixture' };
  return { repository, account, image, source, availability, config, network, worker, service, input, actor };
}

describe('SingleInstancesService', () => {
  it('rejects a launch whose expiration time is already in the past before preparing cloud resources', async () => {
    const ensureDefaultProfile = jest.fn();
    const service = new SingleInstancesService(
      {} as AdminRepository,
      {} as SystemConfigService,
      { ensureDefaultProfile } as unknown as SingleInstanceNetworkService,
      {} as SingleInstanceBatchExecutionService,
      {} as ProvisioningWorkerService,
      {} as RangeInstanceNodeActionsService,
    );

    await expect(
      service.launch(
        {
          name: 'expired-single',
          platformImageAssetId: 'asset-1',
          cpu: 2,
          memory: 2,
          quantity: 1,
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        'user-1',
      ),
    ).rejects.toThrow('到期时间');
    expect(ensureDefaultProfile).not.toHaveBeenCalled();
  });

  it('performs slow cloud specification checks outside the intake lock and only queues OpenTofu jobs', async () => {
    const fixture = createLaunchFixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.config.getInstanceTypeAvailabilityInContext.mockImplementation(async () => { enter(); await gate; return fixture.availability; });
    const launching = fixture.service.launch(fixture.input, fixture.actor.id);
    await entered;
    expect(fixture.repository.withSingleInstanceControlLock).not.toHaveBeenCalled();
    const previous = await fixture.repository.createRangeInstance({ name: 'existing', ownerUserId: fixture.actor.id, instanceMode: 'single', status: 'running' });
    const destroy = await fixture.service.destroy(previous.id, fixture.actor as never);
    expect(destroy.status).toBe('pending');
    expect(fixture.worker.dispatch).not.toHaveBeenCalled();
    release();
    const launched = await launching;
    expect(launched.instances).toHaveLength(2);
    for (const instance of launched.instances) {
      expect(instance.status).toBe('pending_create');
      const persisted = await fixture.repository.getRangeInstanceById(instance.id);
      expect(persisted?.singleInstanceConfig).toEqual(expect.objectContaining({ executionBackend: 'opentofu',
        cloudAccountUid: fixture.account.accountUid, cloudAccountContextId: fixture.account.cloudAccountContextId }));
      expect((await fixture.repository.getProvisionJobById(instance.lastJobId!))?.status).toBe('pending');
    }
    expect(fixture.worker.dispatch).not.toHaveBeenCalled();
  });

  it.each(['cloudAccountContextId', 'accountUid', 'defaultRegion', 'defaultZoneId', 'accessKeyId', 'accessKeySecret', 'imageImportBucket'] as const)
  ('rejects a changed cloud context field %s before preparing a network or recording a batch', async field => {
    const fixture = createLaunchFixture();
    fixture.config.getInstanceTypeAvailabilityInContext.mockImplementation(async () => {
      fixture.account[field] = `changed-${field}`;
      return fixture.availability;
    });
    await expect(fixture.service.launch(fixture.input, fixture.actor.id)).rejects.toThrow('云账号配置');
    expect(fixture.network.ensureDefaultProfile).not.toHaveBeenCalled();
    expect(await fixture.repository.listRangeInstances()).toEqual([]);
    expect(await fixture.repository.listSingleInstanceBatchesWithInstances()).toEqual([]);
  });

  it.each(['image', 'source'] as const)('rechecks %s eligibility after the cloud precheck', async target => {
    const fixture = createLaunchFixture();
    fixture.config.getInstanceTypeAvailabilityInContext.mockImplementation(async () => {
      if (target === 'image') fixture.image.enabled = false;
      else fixture.source.isAvailable = false;
      return fixture.availability;
    });
    await expect(fixture.service.launch(fixture.input, fixture.actor.id)).rejects.toThrow(target === 'image' ? 'not found' : 'exporting');
    expect(fixture.network.ensureDefaultProfile).not.toHaveBeenCalled();
    expect(await fixture.repository.listProvisionJobs()).toEqual([]);
  });

  it('does not enqueue when the expiration passes during first-network preparation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T00:00:00Z'));
    try {
      const fixture = createLaunchFixture();
      fixture.input.expiresAt = new Date(Date.now() + 1000).toISOString();
      fixture.network.ensureDefaultProfile.mockImplementationOnce(async () => {
        jest.setSystemTime(new Date(Date.now() + 2000));
        return {};
      });
      await expect(fixture.service.launch(fixture.input, fixture.actor.id)).rejects.toThrow('到期时间');
      expect(await fixture.repository.listProvisionJobs()).toEqual([]);
      expect(await fixture.repository.listSingleInstanceBatchesWithInstances()).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  it('only queues batch destruction and retries; neither endpoint invokes the API executor', async () => {
    const fixture = createLaunchFixture();
    const launched = await fixture.service.launch(fixture.input, fixture.actor.id);
    for (const member of launched.instances) await fixture.repository.updateRangeInstance(member.id, { status: 'running' });
    await fixture.service.destroyBatch(launched.batch.id, fixture.actor as never);
    for (const member of launched.instances) {
      const instance = await fixture.repository.getRangeInstanceById(member.id);
      expect(instance?.status).toBe('pending_destroy');
      expect((await fixture.repository.getProvisionJobById(instance!.lastJobId!))?.status).toBe('pending');
    }
    await fixture.repository.updateRangeInstance(launched.instances[0].id, { status: 'destroy_failed' });
    const retry = await fixture.service.retry(launched.instances[0].id, fixture.actor as never);
    expect(retry.status).toBe('pending');
    expect(fixture.worker.dispatch).not.toHaveBeenCalled();
  });
});
