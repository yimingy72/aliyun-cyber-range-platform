import { PrismaService } from '../src/database/prisma.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { signAliyunRpcQuery } from '../src/admin/image-catalog-rpc-signer';
import { buildSingleInstanceBlueprint } from '../src/admin/single-instance-blueprint';
import { FAILED_CREATE_CLEANUP_PROOF_STEP, FAILED_CREATE_SWITCH_PROOF_STEP } from '../src/admin/failed-create-cleanup-evidence';

const describeDatabase = process.env.SETTINGS_SWITCH_TEST_DATABASE_URL ? describe : describe.skip;
const originalFetch = global.fetch;
const base = { provider: 'alibaba_cloud' as const, displayName: 'Test account', accountUid: 'test-old-account', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', accessKeyId: 'test-old-id', accessKeySecret: 'test-old-secret', imageImportBucket: '', status: 'ready' as const, bucketStatus: 'unconfigured', isActive: true, createdAt: new Date('2026-10-07T00:00:00Z') };
const target = { defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'test-new-id', accessKeySecret: 'test-new-secret', imageImportBucket: '' };
const emptyEcs = { RequestId: 'test-ecs-request', PageNumber: 1, PageSize: 1, TotalCount: 0, Instances: { Instance: [] } };
const claimStartedAt = new Date('2026-10-08T00:00:00Z');

describeDatabase('atomic cloud configuration switch safety (isolated PostgreSQL)', () => {
  const prisma = new PrismaService({ datasources: { db: { url: process.env.SETTINGS_SWITCH_TEST_DATABASE_URL } } });
  const cloud = new CloudAccountContextsService(prisma);
  const system = new SystemConfigService(prisma, cloud);
  async function seed() {
    await prisma.cloudAccountContext.create({ data: { id: 'context-old', ...base } });
    await prisma.systemCloudConfig.create({ data: { id: 'default', provider: 'alibaba_cloud', defaultRegion: base.regionId, defaultZoneId: base.zoneId, accessKeyId: base.accessKeyId, accessKeySecret: base.accessKeySecret } });
  }
  async function failed(mode: 'single' | 'range' = 'single') {
    const blueprint = buildSingleInstanceBlueprint({
      name: 'test-failed', hostKey: 'test-ecs', hostName: 'test-ecs', privateIp: '10.99.1.10',
      password: 'Test-fixture-password-only!', cpu: 2, memory: 4, image: { imageId: 'test-image' } as never,
      regionId: base.regionId, zoneId: base.zoneId, vpcCidr: '10.99.0.0/16', zoneKey: 'dmz', zoneCidr: '10.99.1.0/24',
    });
    const instance = await prisma.rangeInstance.create({ data: {
      name: 'test failed', status: 'create_failed', instanceMode: mode,
      runtimeScenarioTemplateSpec: blueprint.runtimeScenarioTemplateSpec as never,
      runtimeCompiledProvisionSpec: blueprint.runtimeCompiledProvisionSpec as never,
      singleInstanceConfig: mode === 'single' ? {
        baseName: 'test-failed', quantityIndex: 1, hostKey: 'test-ecs', hostName: 'test-ecs',
        platformImageAssetId: 'test-platform-image', imageId: 'test-image', imageDisplayName: 'Test image',
        cpu: 2, memory: 4, systemDiskSize: 40, remark: null, assignedVswitchId: 'vsw-test-source',
      } : undefined,
    } });
    const job = await prisma.provisionJob.create({ data: { rangeInstanceId: instance.id, jobType: 'create', status: 'failed', triggeredBy: 'test', startedAt: claimStartedAt, finishedAt: new Date() } });
    await prisma.rangeInstance.update({ where: { id: instance.id }, data: { lastJobId: job.id } });
    return { instance, job };
  }
  function provider(accountUid = base.accountUid, response: unknown = emptyEcs) {
    const mock = jest.fn(async (url: string) => {
      if (new URL(url).searchParams.get('Action') === 'GetCallerIdentity') {
        return new Response(JSON.stringify({ AccountId: accountUid }), { status: 200 });
      }
      return new Response(JSON.stringify(response), { status: 200 });
    });
    global.fetch = mock as typeof global.fetch;
    return mock;
  }
  async function unchanged() {
    expect(await prisma.cloudAccountContext.count()).toBe(1);
    expect(await prisma.cloudAccountContext.findUnique({ where: { id: 'context-old' } })).toMatchObject(base);
    expect(await prisma.systemCloudConfig.findUnique({ where: { id: 'default' } })).toMatchObject({ defaultRegion: 'cn-beijing', accessKeyId: 'test-old-id', accessKeySecret: 'test-old-secret' });
    expect(await prisma.provisionJobStepLog.count()).toBe(0);
  }
  async function proofRecord(entry: Awaited<ReturnType<typeof failed>>, override: Record<string, unknown> = {}) {
    const proof = { version: 1, rangeInstanceId: entry.instance.id, provisionJobId: entry.job.id, claimStartedAt: claimStartedAt.toISOString(), cloudAccountContextId: 'context-old', cloudAccountUid: base.accountUid, regionId: base.regionId, ...override };
    await prisma.provisionJobStepLog.create({ data: { jobId: entry.job.id, stepName: FAILED_CREATE_CLEANUP_PROOF_STEP, status: 'succeeded', message: JSON.stringify(proof), startedAt: new Date(), finishedAt: new Date() } });
  }
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "CloudAccountContext", "SystemCloudConfig", "RangeInstance", "BillingLedgerResource", "ImageImportJob" CASCADE');
    global.fetch = jest.fn().mockRejectedValue(new Error('Unplanned cloud call blocked'));
  });
  afterAll(async () => { global.fetch = originalFetch; await prisma.$disconnect(); });

  it('switches two legacy failed singles only after strict empty results in the old region and saves proof without credentials', async () => {
    await seed(); const entries = await Promise.all([failed(), failed()]); const fetchMock = provider();
    expect(await system.updateSnapshot(target)).toMatchObject({ defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' });
    expect(await prisma.cloudAccountContext.count({ where: { isActive: true } })).toBe(1);
    const requests = fetchMock.mock.calls.slice(1).map(([url]) => new URL(url));
    expect(requests).toHaveLength(2);
    for (const url of requests) {
      expect(url.searchParams.get('Action')).toBe('DescribeInstances');
      expect(url.searchParams.get('RegionId')).toBe('cn-beijing');
      expect(url.searchParams.get('AccessKeyId')).toBe('test-new-id');
      const parameters = Object.fromEntries(url.searchParams); delete parameters.Signature;
      expect(new URLSearchParams(signAliyunRpcQuery(parameters, 'test-new-secret')).get('Signature')).toBe(url.searchParams.get('Signature'));
      expect(url.searchParams.get('Tag.1.Key')).toBe('RangeInstanceId');
    }
    expect(requests.map(url => url.searchParams.get('Tag.1.Value')).sort()).toEqual(entries.map(e => e.instance.id).sort());
    const logs = await prisma.provisionJobStepLog.findMany();
    expect(logs).toHaveLength(2);expect(logs.every(log => log.stepName === FAILED_CREATE_SWITCH_PROOF_STEP)).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/test-(?:old|new)-(?:id|secret)/);
    expect(await prisma.rangeInstance.findMany()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'create_failed' })]));
    expect(await prisma.systemCloudConfig.findUnique({ where: { id: 'default' } })).toMatchObject({ defaultRegion: 'cn-hangzhou' });
  });
  it('uses only the old account credentials for the old-region probe when STS identifies a different account', async () => {
    await seed(); await failed(); const mock = provider('test-different-account');
    await system.updateSnapshot(target);
    const url = new URL(mock.mock.calls[1][0]);
    expect(url.searchParams.get('AccessKeyId')).toBe('test-old-id');
    const parameters = Object.fromEntries(url.searchParams); delete parameters.Signature;
    expect(new URLSearchParams(signAliyunRpcQuery(parameters, 'test-old-secret')).get('Signature')).toBe(url.searchParams.get('Signature'));
  });
  it('queries the saved source region and inactive context rather than the current active region', async () => {
    await seed(); const entry = await failed();
    await prisma.cloudAccountContext.update({ where: { id: 'context-old' }, data: { isActive: false } });
    await prisma.cloudAccountContext.create({ data: { id: 'context-current', ...base, regionId: 'cn-shanghai', zoneId: 'cn-shanghai-g', accountUid: 'test-current-account', accessKeyId: 'test-current-id', accessKeySecret: 'test-current-secret' } });
    const mock = provider('test-current-account');
    await system.updateSnapshot(target);
    const url = new URL(mock.mock.calls[1][0]);
    expect(url.searchParams.get('RegionId')).toBe('cn-beijing');
    expect(url.searchParams.get('AccessKeyId')).toBe('test-old-id');
    const parameters = Object.fromEntries(url.searchParams);delete parameters.Signature;
    expect(new URLSearchParams(signAliyunRpcQuery(parameters, 'test-old-secret')).get('Signature')).toBe(url.searchParams.get('Signature'));
    const proof = JSON.parse((await prisma.provisionJobStepLog.findFirstOrThrow({ where: { jobId: entry.job.id } })).message!);
    expect(proof).toMatchObject({ cloudAccountContextId: 'context-old', cloudAccountUid: 'test-old-account', regionId: 'cn-beijing' });
  });
  it.each(['missing', 'conflicting', 'malformed compiled', 'no context', 'multiple accounts', 'missing assigned switch', 'late source context'])('rejects %s source data before an ECS call', async kind => {
    await seed(); const entry = await failed();
    if (kind === 'missing') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { runtimeScenarioTemplateSpec: { topology: {} } } });
    if (kind === 'conflicting') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { runtimeCompiledProvisionSpec: { topology: { defaultRegion: 'cn-shanghai' } } } });
    if (kind === 'malformed compiled') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { runtimeCompiledProvisionSpec: { topology: { defaultRegion: null } } } });
    if (kind === 'no context') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { runtimeScenarioTemplateSpec: { topology: { defaultRegion: 'cn-shanghai' } } } });
    if (kind === 'multiple accounts') await prisma.cloudAccountContext.create({ data: { id: 'context-ambiguous', ...base, accountUid: 'test-other-account', isActive: false } });
    if (kind === 'missing assigned switch') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { singleInstanceConfig: { cpu: 2, memory: 4 } } });
    if (kind === 'late source context') await prisma.cloudAccountContext.update({ where: { id: 'context-old' }, data: { createdAt: new Date(claimStartedAt.getTime() + 1) } });
    const mock = provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
    expect(mock).toHaveBeenCalledTimes(1);expect(await prisma.provisionJobStepLog.count()).toBe(0);
    expect(await prisma.cloudAccountContext.findUnique({ where: { id: 'context-old' } })).toMatchObject({ ...base, ...(kind === 'late source context' ? { createdAt: new Date(claimStartedAt.getTime() + 1) } : {}) });
    expect(await prisma.cloudAccountContext.count()).toBe(kind === 'multiple accounts' ? 2 : 1);
    expect(await prisma.systemCloudConfig.findUnique({ where: { id: 'default' } })).toMatchObject({ defaultRegion: 'cn-beijing' });
  });
  it('does not trust a single proof for another persisted source region', async () => {
    await seed(); const entry = await failed();
    await prisma.cloudAccountContext.create({ data: { id: 'context-shanghai', ...base, regionId: 'cn-shanghai', zoneId: 'cn-shanghai-g', isActive: false } });
    await proofRecord(entry, { cloudAccountContextId: 'context-shanghai', regionId: 'cn-shanghai' });
    const mock = provider(base.accountUid, { ...emptyEcs, TotalCount: 1, Instances: { Instance: [{ InstanceId: 'test-live-source' }] } });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
    expect(mock).toHaveBeenCalledTimes(2);expect(new URL(mock.mock.calls[1][0]).searchParams.get('RegionId')).toBe('cn-beijing');
    expect(await prisma.cloudAccountContext.count()).toBe(2);
  });
  it('rejects inactive source credential changes while verification is in flight', async () => {
    await seed(); await failed();
    await prisma.cloudAccountContext.update({ where: { id: 'context-old' }, data: { isActive: false } });
    await prisma.cloudAccountContext.create({ data: { id: 'context-current', ...base, regionId: 'cn-shanghai', zoneId: 'cn-shanghai-g', accountUid: 'test-current-account' } });
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: 'test-current-account' }), { status: 200 })).mockImplementationOnce(async () => {
      await prisma.cloudAccountContext.update({ where: { id: 'context-old' }, data: { accessKeySecret: 'test-concurrent-change' } });
      return new Response(JSON.stringify(emptyEcs), { status: 200 });
    });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.cloudAccountContext.count()).toBe(2);expect(await prisma.provisionJobStepLog.count()).toBe(0);
    expect((await prisma.cloudAccountContext.findUniqueOrThrow({ where: { id: 'context-current' } })).isActive).toBe(true);
    expect(await prisma.systemCloudConfig.findUnique({ where: { id: 'default' } })).toMatchObject({ defaultRegion: 'cn-beijing' });
  });
  it.each([
    ['missing total', { ...emptyEcs, TotalCount: undefined }],
    ['missing instances', { ...emptyEcs, Instances: undefined }],
    ['invalid array', { ...emptyEcs, Instances: { Instance: {} } }],
    ['error payload', { ...emptyEcs, Code: 'Forbidden' }],
    ['count inconsistency', { ...emptyEcs, Instances: { Instance: [{ InstanceId: 'test-live' }] } }],
    ['resource count', { ...emptyEcs, TotalCount: 1, Instances: { Instance: [{ InstanceId: 'test-live' }] } }],
    ['string count', { ...emptyEcs, TotalCount: '0' }],
    ['wrong page', { ...emptyEcs, PageNumber: 2 }],
    ['missing request id', { ...emptyEcs, RequestId: undefined }],
  ])('fails closed for %s without leaving a context or changing credentials', async (_name, payload) => {
    await seed(); await failed(); provider(base.accountUid, payload);
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 }); await unchanged();
  });
  it.each(['network', '403', 'bad JSON'])('fails closed for ECS %s', async kind => {
    await seed(); await failed();
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: base.accountUid }), { status: 200 }))
      .mockImplementationOnce(async () => { if (kind === 'network') throw new Error('test network'); return new Response(kind === 'bad JSON' ? 'broken' : '{}', { status: kind === '403' ? 403 : 200 }); });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 }); await unchanged();
  });
  it('keeps an unknown failed range blocked without querying ECS', async () => {
    await seed(); await failed('range'); const mock = provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });expect(mock).toHaveBeenCalledTimes(1);await unchanged();
  });
  it('accepts only a claim-bound cleanup proof for a failed range', async () => {
    await seed(); const entry = await failed('range'); await proofRecord(entry); const mock = provider();
    await system.updateSnapshot(target);expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['old claim', { claimStartedAt: '2020-01-01T00:00:00Z' }],
    ['old job', { provisionJobId: 'test-unrelated-job' }],
    ['other instance', { rangeInstanceId: 'test-unrelated-instance' }],
    ['wrong account', { cloudAccountUid: 'test-unrelated-account' }],
    ['wrong region', { regionId: 'cn-hangzhou' }],
  ])('does not reuse proof for %s', async (_name, override) => {
    await seed(); const entry = await failed('range'); await proofRecord(entry, override); provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.cloudAccountContext.count()).toBe(1);
  });
  it('does not trust a generic cleanup succeeded log from a previous worker reporter', async () => {
    await seed(); const entry = await failed('range');
    await prisma.provisionJobStepLog.create({ data: { jobId: entry.job.id, stepName: 'cleanup_failed_create_resources', status: 'succeeded', startedAt: new Date(), finishedAt: new Date() } }); provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
  });
  it('allows untouched drafts but blocks a draft with any resource task', async () => {
    await seed(); const draft = await prisma.rangeInstance.create({ data: { name: 'test draft', status: 'draft' } }); provider();
    await system.updateSnapshot(target);
    const job = await prisma.provisionJob.create({ data: { rangeInstanceId: draft.id, jobType: 'create', status: 'failed', triggeredBy: 'test' } });
    await prisma.rangeInstance.update({ where: { id: draft.id }, data: { lastJobId: job.id } });
    await expect(system.updateSnapshot({ ...target, defaultRegion: 'cn-shanghai', defaultZoneId: 'cn-shanghai-g' })).rejects.toMatchObject({ status: 409 });
  });
  it.each(['pending', 'running'] as const)('keeps %s provision jobs blocking even on destroyed records', async status => {
    await seed(); const instance = await prisma.rangeInstance.create({ data: { name: 'test destroyed', status: 'destroyed' } });
    await prisma.provisionJob.create({ data: { rangeInstanceId: instance.id, jobType: 'destroy', status, triggeredBy: 'test' } }); provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });await unchanged();
  });
  it('keeps destroy_failed and unreleased old-account ledger resources blocked', async () => {
    await seed(); const instance = await prisma.rangeInstance.create({ data: { name: 'test danger', status: 'destroy_failed' } }); provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });
    await prisma.rangeInstance.delete({ where: { id: instance.id } });
    await prisma.billingLedgerResource.create({ data: { cloudAccountUid: base.accountUid, regionId: base.regionId, cloudResourceId: 'test-image', cloudResourceType: 'image', billingScope: 'platform', billingStartAt: new Date() } });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });await unchanged();
  });
  it('rejects a cloud proof if the claim changes during the provider request', async () => {
    await seed(); const entry = await failed();
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: base.accountUid }), { status: 200 })).mockImplementationOnce(async () => {
      await prisma.provisionJob.update({ where: { id: entry.job.id }, data: { startedAt: new Date(claimStartedAt.getTime() + 1) } });
      return new Response(JSON.stringify(emptyEcs), { status: 200 });
    });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });await unchanged();
  });
  it('rejects new pending jobs submitted while cloud verification was in flight', async () => {
    await seed(); const entry = await failed();
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: base.accountUid }), { status: 200 })).mockImplementationOnce(async () => {
      await prisma.provisionJob.create({ data: { rangeInstanceId: entry.instance.id, jobType: 'create', status: 'pending', triggeredBy: 'test' } });
      return new Response(JSON.stringify(emptyEcs), { status: 200 });
    });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });await unchanged();
  });
  it.each(['summary', 'missing claim'])('blocks an unknown failure with %s before any ECS query', async kind => {
    await seed(); const entry = await failed();
    if (kind === 'summary') await prisma.rangeInstance.update({ where: { id: entry.instance.id }, data: { resourceSummary: { hostIds: { ecs: 'test-known-resource' } } } });
    else await prisma.provisionJob.update({ where: { id: entry.job.id }, data: { startedAt: null } });
    const mock = provider();
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });expect(mock).toHaveBeenCalledTimes(1);await unchanged();
  });
  it('rejects active configuration changes made while the cloud request was in flight', async () => {
    await seed(); await failed();
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: base.accountUid }), { status: 200 })).mockImplementationOnce(async () => {
      await prisma.cloudAccountContext.update({ where: { id: 'context-old' }, data: { zoneId: 'cn-beijing-k' } }); return new Response(JSON.stringify(emptyEcs), { status: 200 });
    });
    await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });expect(await prisma.cloudAccountContext.count()).toBe(1);expect(await prisma.provisionJobStepLog.count()).toBe(0);
  });
  it.each(['upsert', 'clear active', 'activate', 'system config'].flatMap(stage => [[stage, false], [stage, true]] as const))('rolls back %s failure for existing-context=%s', async (stage, sameContext) => {
    await seed(); provider();
    const wrapped = new Proxy(prisma, { get(db, key) {
      if (key !== '$transaction') return Reflect.get(db, key);
      return (callback: (tx: unknown) => unknown, options: unknown) => db.$transaction(async tx => {
        const delegate = stage === 'system config' ? 'systemCloudConfig' : 'cloudAccountContext';
        const method = stage === 'clear active' ? 'updateMany' : stage === 'activate' ? 'update' : 'upsert';
        const proxy = new Proxy(tx, { get(inner, name) {
          if (name !== delegate) return Reflect.get(inner, name);
          return new Proxy(Reflect.get(inner, name), { get(model, operation) {
            if (operation === method) return jest.fn().mockRejectedValue(new Error(`Injected ${stage}`));
            return Reflect.get(model, operation);
          } });
        } });
        return callback(proxy);
      }, options as never);
    } });
    await expect(new CloudAccountContextsService(wrapped).saveFromCloudConfig(sameContext ? { ...target, defaultRegion: base.regionId, defaultZoneId: 'cn-beijing-k' } : target)).rejects.toThrow(`Injected ${stage}`);await unchanged();
  });
  it('serializes first saves so only one context is active and SystemConfig matches it', async () => {
    provider(); const results = await Promise.allSettled([cloud.saveFromCloudConfig(target), cloud.saveFromCloudConfig({ ...target, defaultRegion: 'cn-shanghai', defaultZoneId: 'cn-shanghai-g' })]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.cloudAccountContext.count({ where: { isActive: true } })).toBe(1);
    const active = await prisma.cloudAccountContext.findFirstOrThrow({ where: { isActive: true } });
    expect(await prisma.systemCloudConfig.findUnique({ where: { id: 'default' } })).toMatchObject({ defaultRegion: active.regionId, defaultZoneId: active.zoneId });
  });
  it('fails closed with 409 when resource DML holds a conflicting table lock', async () => {
    await seed(); provider();let release!: () => void;let acquired!: () => void;
    const held = new Promise<void>(resolve => acquired = resolve);const unblock = new Promise<void>(resolve => release = resolve);
    const holder = prisma.$transaction(async tx => { await tx.$executeRaw`LOCK TABLE "RangeInstance" IN ROW EXCLUSIVE MODE`;acquired();await unblock; }, { timeout: 10_000 });
    await held;
    try { await expect(system.updateSnapshot(target)).rejects.toMatchObject({ status: 409 });await unchanged(); } finally { release();await holder; }
  });
});
