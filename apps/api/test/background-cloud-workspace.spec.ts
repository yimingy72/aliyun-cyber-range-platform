import { runInCloudWorkspace, runInSystemCloudWorkspaceScope, getCurrentCloudWorkspaceScope, getCurrentCloudWorkspaceId } from '../src/auth/cloud-workspace-scope';
import { runInExecutionCloudWorkspace, listExecutionCloudWorkspaces } from '../src/auth/background-cloud-workspace';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { ImageImportsService } from '../src/admin/image-imports.service';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const spaces = [
  { id: 'account-a', provider: 'alibaba_cloud' as const, accountUid: 'uid-a', isReadOnly: false },
  { id: 'account-b', provider: 'alibaba_cloud' as const, accountUid: 'uid-b', isReadOnly: false },
  { id: 'account-tencent', provider: 'tencent_cloud' as const, accountUid: 'uid-tencent', isReadOnly: false },
  { id: 'historical', provider: 'alibaba_cloud' as const, accountUid: null, isReadOnly: true },
];
const scope = (id: string) => { const row = spaces.find(row => row.id === id)!; return { cloudWorkspaceId: row.id, provider: row.provider, accountUid: row.accountUid, isReadOnly: row.isReadOnly }; };
const runner = () => ({
  listExecutionCloudWorkspaces: jest.fn(async () => spaces),
  runInWorkspace: jest.fn(async (id: string, work: () => Promise<unknown>) => runInCloudWorkspace(scope(id), work)),
  getSnapshot: jest.fn(async () => ({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fixture', accessKeySecret: 'fixture' })),
  getAccountContext: jest.fn(async () => ({ provider: 'alibaba_cloud', accountUid: getCurrentCloudWorkspaceScope() && (getCurrentCloudWorkspaceScope() as any).accountUid, accountUidResolved: true, defaultRegion: 'cn-hangzhou' })),
});
const singleConfig = (id: string) => ({ baseName: 'fixture', quantityIndex: 1, hostKey: 'single', hostName: 'fixture', platformImageAssetId: 'asset', imageId: 'image', imageDisplayName: 'fixture', cpu: 2, memory: 4, systemDiskSize: 40, cloudAccountUid: scope(id).accountUid, cloudAccountContextId: `context-${id}`, regionId: 'cn-hangzhou' });
async function single(repository: ReturnType<typeof createMemoryAdminRepository>, id: string, status = 'pending_create') {
  return runInCloudWorkspace(scope(id), async () => {
    const instance = await repository.createRangeInstance({ name: `instance-${id}`, instanceMode: 'single', status: status as any, singleInstanceConfig: singleConfig(id), expiresAt: status === 'running' ? new Date(0).toISOString() : undefined });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture' });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
    if (status === 'running') await repository.updateProvisionJob(job.id, { status: 'succeeded', finishedAt: new Date() });
    return { instance, job };
  });
}
const packed = (repository: ReturnType<typeof createMemoryAdminRepository>, id: string) => runInCloudWorkspace(scope(id), () => repository.createPackedImageArtifact({ cloudAccountContextId: `context-${id}`, cloudAccountUid: scope(id).accountUid!, regionId: 'cn-hangzhou', ownerUserId: 'owner', sourceRangeInstanceId: `range-${id}`, sourceHostKey: 'host', sourceInstanceId: `instance-${id}`, sourceDiskIds: ['d-owned'] }));

// Only synthetic memory repositories and clients are used; no cloud connections are made.
describe('Frozen source workspaces for background tasks', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('rejects a frozen UID mismatch before executing and filters unverified or unsupported polling spaces', async () => {
    const config = runner(), execute = jest.fn(async () => undefined);
    await expect(runInExecutionCloudWorkspace(config, 'account-a', execute, { provider: 'alibaba_cloud', accountUid: 'uid-b' })).rejects.toThrow('frozen cloud workspace');
    expect(execute).not.toHaveBeenCalled();
    await expect(listExecutionCloudWorkspaces(config)).resolves.toEqual(spaces.slice(0, 2));
  });

  it('refuses missing background runners in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await expect(runInExecutionCloudWorkspace({}, 'account-a', async () => undefined)).rejects.toThrow('verified cloud workspace runner'); }
    finally { process.env.NODE_ENV = previous; }
  });

  it('keeps concurrent single-instance execution in its original account after the UI selects Tencent', async () => {
    const repository = createMemoryAdminRepository(), config = runner();
    const a = await single(repository, 'account-a'), b = await single(repository, 'account-b');
    const executed: string[] = [];
    const executor = { executeCreateBatch: jest.fn(async (items: any[]) => { await new Promise(resolve => setImmediate(resolve)); executed.push(getCurrentCloudWorkspaceId()!); for (const item of items) await repository.updateProvisionJob(item.job.id, { status: 'succeeded' }); }) };
    const worker = new ProvisioningWorkerService(repository, {} as any, config as any, executor as any);
    await runInCloudWorkspace(scope('account-tencent'), () => Promise.all([worker.process(a.job.id), worker.process(b.job.id)]));
    expect(executed.sort()).toEqual(['account-a', 'account-b']);
    expect(config.runInWorkspace.mock.calls.map(([id]) => id).sort()).toEqual(['account-a', 'account-b']);
    const jobs = await runInSystemCloudWorkspaceScope(() => repository.listProvisionJobs());
    expect(jobs.every(job => job.status === 'succeeded')).toBe(true);
  });

  it('rejects a job whose recorded workspace differs from the target before claiming it', async () => {
    const repository = createMemoryAdminRepository(), config = runner();
    const a = await single(repository, 'account-a');
    const foreign = await runInCloudWorkspace(scope('account-b'), () => repository.createProvisionJob({ rangeInstanceId: a.instance.id, jobType: 'destroy', triggeredBy: 'fixture' }));
    const executor = { executeDestroyBatch: jest.fn() };
    const worker = new ProvisioningWorkerService(repository, {} as any, config as any, executor as any);
    await expect(worker.process(foreign.id)).rejects.toThrow('different cloud workspaces');
    expect(config.runInWorkspace).not.toHaveBeenCalled();
    expect(executor.executeDestroyBatch).not.toHaveBeenCalled();
    await expect(runInSystemCloudWorkspaceScope(() => repository.getProvisionJobById(foreign.id))).resolves.toMatchObject({ status: 'pending' });
  });

  it('skips a historical queue backlog without reserving executable account slots', async () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const repository = createMemoryAdminRepository(), config = runner();
    await runInSystemCloudWorkspaceScope(async () => {
      for (let index = 0; index < 3; index++) {
        const instance = await repository.createRangeInstance({ cloudWorkspaceId: 'historical', name: `historical-${index}`, instanceMode: 'single', status: 'pending_create' });
        await repository.createProvisionJob({ cloudWorkspaceId: 'historical', rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture' });
      }
    });
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const a = await single(repository, 'account-a');
    const executor = { executeCreateBatch: jest.fn(async (items: any[]) => { for (const item of items) await repository.updateProvisionJob(item.job.id, { status: 'succeeded' }); }) };
    const worker = new ProvisioningWorkerService(repository, {} as any, config as any, executor as any);
    expect(await (worker as any).startEligiblePendingJobs()).toBe(1);
    await Promise.all([...(worker as any).activeTasks]);
    expect(executor.executeCreateBatch).toHaveBeenCalledTimes(1);
    expect(config.runInWorkspace.mock.calls.map(([id]) => id)).toEqual(['account-a']);
    await expect(runInSystemCloudWorkspaceScope(() => repository.getProvisionJobById(a.job.id))).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('creates automatic expiration destroy jobs in each instance source space', async () => {
    const repository = createMemoryAdminRepository(), config = runner();
    const a = await single(repository, 'account-a', 'running'), b = await single(repository, 'account-b', 'running');
    const worker = new ProvisioningWorkerService(repository, {} as any, config as any);
    await runInCloudWorkspace(scope('account-tencent'), () => worker.processExpiredInstances(new Date()));
    const jobs = (await runInSystemCloudWorkspaceScope(() => repository.listProvisionJobs())).filter(job => job.jobType === 'destroy');
    expect(jobs.map(job => [job.rangeInstanceId, job.cloudWorkspaceId]).sort()).toEqual([[a.instance.id, 'account-a'], [b.instance.id, 'account-b']].sort());
  });

  it('continues other resource reconciliations when one account fails', async () => {
    const config = runner(), visited: string[] = [];
    const reconcile = jest.fn(async () => { visited.push(getCurrentCloudWorkspaceId()!); if (getCurrentCloudWorkspaceId() === 'account-a') throw new Error('Synthetic permission failure'); return {}; });
    const worker = new ProvisioningWorkerService(createMemoryAdminRepository(), {} as any, config as any, {} as any, { reconcile } as any);
    await expect(worker.reconcilePlatformResources(new Date())).rejects.toThrow('other source workspaces');
    expect(visited).toEqual(['account-a', 'account-b']);
  });

  it('uses the range frozen zone after account defaults change', async () => {
    const config = { ...runner(), getAccountContextById: jest.fn(async () => ({ provider: 'alibaba_cloud', accountUid: 'uid-a', accountUidResolved: true, cloudAccountContextId: 'context-a', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-i' })) };
    const worker = new ProvisioningWorkerService(createMemoryAdminRepository(), { mode: 'opentofu' } as any, config as any);
    const instance = { cloudProvider: 'alibaba_cloud', resourceSummary: { executionContext: { cloudAccountContextId: 'context-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' } } };
    await expect((worker as any).resolveRangeAccountContext(instance, {})).resolves.toMatchObject({ defaultZoneId: 'cn-hangzhou-h' });
    config.getAccountContextById.mockResolvedValueOnce({ ...(await config.getAccountContextById()), accountUid: 'uid-b' });
    await expect((worker as any).resolveRangeAccountContext(instance, {})).rejects.toThrow('frozen cloud identity');
  });

  it('discovers import jobs globally but refreshes each in its source account', async () => {
    const config = runner(), queries: any[] = [];
    const jobs = spaces.slice(0, 2).map(space => ({ id: `import-${space.id}`, cloudWorkspaceId: space.id, cloudAccountUid: space.accountUid }));
    const prisma = { imageImportJob: { findMany: jest.fn(async (query) => { expect(getCurrentCloudWorkspaceScope()).toEqual({ system: true }); queries.push(query); return query.select ? jobs : []; }) } };
    const service = new ImageImportsService({} as any, prisma as any, {} as any, config as any);
    const visited: Array<[string, string | null]> = [];
    jest.spyOn(service, 'refreshImport').mockImplementation(async id => { visited.push([id, getCurrentCloudWorkspaceId()]); return {} as any; });
    await runInCloudWorkspace(scope('account-tencent'), () => service.refreshPendingImports());
    expect(visited.sort()).toEqual([['import-account-a', 'account-a'], ['import-account-b', 'account-b']]);
    expect(queries.every(query => JSON.stringify(query.where.cloudWorkspaceId) === JSON.stringify({ in: ['account-a', 'account-b'] }))).toBe(true);
  });

  it('keeps packed artifact and snapshot accounting in the source workspace', async () => {
    const repository = createMemoryAdminRepository(), config = runner();
    const a = await packed(repository, 'account-a'), b = await packed(repository, 'account-b');
    const service = new PackedImagesService(repository, {} as any, config as any);
    jest.spyOn(service, 'refresh').mockImplementation(async id => {
      const artifact = (await repository.getPackedImageArtifact(id))!;
      await repository.createBillingLedgerResource({ cloudAccountUid: artifact.cloudAccountUid, regionId: artifact.regionId, cloudResourceId: `s-${id}`, cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: artifact.ownerUserId, billingStartAt: new Date(), tagsSnapshot: {} });
      return artifact;
    });
    await runInCloudWorkspace(scope('account-tencent'), () => service.refreshPending());
    const ledgers = await runInSystemCloudWorkspaceScope(() => repository.listBillingLedgerResources());
    expect(ledgers.map(row => [row.cloudResourceId, row.cloudWorkspaceId, row.cloudAccountUid]).sort()).toEqual([[`s-${a.id}`, 'account-a', 'uid-a'], [`s-${b.id}`, 'account-b', 'uid-b']].sort());
  });

  it('schedules billing for every verified Ali account rather than the selected UI account', async () => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    const previous = process.env.BILLING_SYNC_INTERVAL_MS; process.env.BILLING_SYNC_INTERVAL_MS = '21600000';
    const config = runner(), service = new BillingSyncService({} as any, {} as any, config as any), visited: string[] = [];
    jest.spyOn(service, 'syncRecentDays').mockImplementation(async () => { visited.push(getCurrentCloudWorkspaceId()!); return {} as any; });
    try { runInCloudWorkspace(scope('account-tencent'), () => service.onModuleInit()); await jest.advanceTimersByTimeAsync(21600000); expect(visited).toEqual(['account-a', 'account-b']); }
    finally { service.onModuleDestroy(); if (previous === undefined) delete process.env.BILLING_SYNC_INTERVAL_MS; else process.env.BILLING_SYNC_INTERVAL_MS = previous; }
  });

  it('does not let another account manual billing synchronization suppress the source account', async () => {
    const config = runner(), repository = createMemoryAdminRepository(), calls: string[] = [];
    const client = { listDailyBillingItems: jest.fn(async () => { await new Promise(resolve => setImmediate(resolve)); calls.push(getCurrentCloudWorkspaceId()!); return []; }) };
    const service = new BillingSyncService(repository, client as any, config as any);
    const results = await Promise.all(['account-a', 'account-b'].map(id => runInCloudWorkspace(scope(id), () => service.syncRange({ startAt: '2026-10-08', endAt: '2026-10-08' }))));
    expect(calls.sort()).toEqual(['account-a', 'account-b']);
    expect(results.every(result => !('syncInProgress' in result))).toBe(true);
  });
});
