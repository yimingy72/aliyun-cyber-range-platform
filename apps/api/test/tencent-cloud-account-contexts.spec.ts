import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';

const input = { provider: 'tencent_cloud' as const, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-tencent-key', accessKeySecret: 'synthetic-tencent-secret' };
const json = (value: unknown) => new Response(JSON.stringify({ Response: { RequestId: 'synthetic-request', ...(value as object) } }));
function fixture() {
  let context: any = null;
  let workspace: any = null;
  const db = {
    cloudWorkspace: {
      findUnique: jest.fn(async () => workspace), findUniqueOrThrow: jest.fn(async () => workspace),
      upsert: jest.fn(async ({ create, update }) => { workspace = workspace ? { ...workspace, ...update } : { id: 'tencent-workspace', isReadOnly: false, activeCloudAccountContextId: null, ...create }; return workspace; }),
      update: jest.fn(async ({ data }) => { workspace = { ...workspace, ...data }; return workspace; }),
    },
    cloudAccountContext: {
      findUnique: jest.fn(async () => context),
      findMany: jest.fn(async () => context ? [context] : []),
      upsert: jest.fn(async ({ create, update }) => {
        context = context ? { ...context, ...update } : { id: 'tencent-context', createdAt: new Date(), updatedAt: new Date(), ...create };
        return context;
      }),
      updateMany: jest.fn(), update: jest.fn(),
    },
    systemCloudConfig: { upsert: jest.fn() }, $transaction: jest.fn(),
  };
  return { db, service: new CloudAccountContextsService(db as never) };
}
describe('Tencent cloud account persistence and isolation', () => {
  const previousKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  beforeEach(() => { process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { if (previousKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = previousKey; });
  function validCloud() {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ AccountId: '100001', UserId: '200001' }))
      .mockResolvedValueOnce(json({ TotalCount: 1, ZoneSet: [{ Zone: input.zoneId, ZoneState: 'AVAILABLE' }] }));
  }
  it('verifies the root AccountId and zone, stores an encrypted inactive context, and leaves Alibaba global config alone', async () => {
    const { db, service } = fixture(); const fetch = validCloud();
    const saved = await service.saveTencentCloudContext(input);
    expect(saved).toMatchObject({ provider: 'tencent_cloud', accountUid: '100001', isActive: false, imageImportBucket: '', bucketStatus: 'unconfigured', status: 'ready' });
    expect(saved.cloudWorkspaceId).toBe('tencent-workspace');
    expect(db.cloudWorkspace.update).toHaveBeenCalledWith({ where: { id: 'tencent-workspace' }, data: { activeCloudAccountContextId: saved.id } });
    expect(saved).not.toHaveProperty('accessKeyId'); expect(saved).not.toHaveProperty('accessKeySecret');
    expect(db.cloudAccountContext.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider_accountUid_regionId: { provider: 'tencent_cloud', accountUid: '100001', regionId: input.regionId } },
      create: expect.objectContaining({ accessKeySecret: expect.stringMatching(/^cloud-credential:v1:/), isActive: false }),
    }));
    expect(JSON.stringify(db.cloudAccountContext.upsert.mock.calls)).not.toContain(input.accessKeySecret);
    expect(db.systemCloudConfig.upsert).not.toHaveBeenCalled(); expect(db.cloudAccountContext.updateMany).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(service.getCredentials(saved.id, { requireReady: true })).resolves.toMatchObject({ provider: 'tencent_cloud', accountUid: '100001', accessKeySecret: input.accessKeySecret });
    await expect(service.getCredentials(saved.id, { requireActive: true })).rejects.toThrow('已启用');
    await expect(service.getCredentials(saved.id, { requireImageImportBucket: true })).rejects.toThrow('暂未支持腾讯云镜像导入');
    await expect(service.activate(saved.id)).rejects.toThrow('仅支持将阿里云'); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('upserts a verified identity rather than a subaccount identity while retaining inactive status', async () => {
    const { db, service } = fixture(); validCloud(); await service.saveTencentCloudContext(input);
    jest.restoreAllMocks(); validCloud(); const saved = await service.saveTencentCloudContext({ ...input, zoneId: input.zoneId, accessKeySecret: 'rotated-tencent-secret' });
    expect(saved).toMatchObject({ id: 'tencent-context', isActive: false, accountUid: '100001' });
    expect(db.cloudAccountContext.upsert).toHaveBeenCalledTimes(2);
    await expect(service.getCredentials(saved.id)).resolves.toMatchObject({ accessKeySecret: 'rotated-tencent-secret' });
  });
  it('encrypts a newly bound Alibaba secret and preserves its verified source for decryption', async () => {
    const { db, service } = fixture();
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: '100001' })));
    const payload = { ...input, provider: 'alibaba_cloud' as const, regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' };
    const saved = await service.saveAccountBinding(payload);
    expect(saved).toMatchObject({ provider: 'alibaba_cloud', accountUid: '100001', isActive: false });
    expect(db.cloudAccountContext.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ accessKeySecret: expect.stringMatching(/^cloud-credential:v1:/) }) }));
    expect(JSON.stringify(db.cloudAccountContext.upsert.mock.calls)).not.toContain(payload.accessKeySecret);
    await expect(service.getCredentials(saved.id, { requireReady: true })).resolves.toMatchObject({ provider: 'alibaba_cloud', accountUid: '100001', accessKeySecret: payload.accessKeySecret });
  });
  it('rejects a missing encryption key before an Alibaba binding identity query or write', async () => {
    delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; const { db, service } = fixture(); const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.saveAccountBinding({ ...input, provider: 'alibaba_cloud', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' })).rejects.toThrow('加密密钥未配置');
    expect(fetch).not.toHaveBeenCalled(); expect(db.cloudWorkspace.upsert).not.toHaveBeenCalled(); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it('rejects missing encryption before cloud reads and persistence', async () => {
    delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; const { db, service } = fixture(); const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.saveTencentCloudContext(input)).rejects.toThrow('加密密钥未配置');
    expect(fetch).not.toHaveBeenCalled(); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it.each([{ AccountId: '' }, { AccountId: 100001 }, { AccountId: 'role:session' }, { UserId: '100001' }])('requires an explicit root AccountId: %j', async (identity) => {
    const { db, service } = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(json(identity));
    await expect(service.saveTencentCloudContext(input)).rejects.toThrow('主账号 AccountId'); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it.each([
    { TotalCount: 2, ZoneSet: [{ Zone: input.zoneId, ZoneState: 'AVAILABLE' }] },
    { TotalCount: 1, ZoneSet: [{ Zone: 'ap-beijing-1', ZoneState: 'AVAILABLE' }] },
    { TotalCount: 1, ZoneSet: [{ Zone: input.zoneId, ZoneState: 'UNAVAILABLE' }] },
    { TotalCount: 0, ZoneSet: [] }, {},
  ])('does not persist an unavailable, mismatched, or incomplete zone response %j', async (zones) => {
    const { db, service } = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ AccountId: '100001' })).mockResolvedValueOnce(json(zones));
    await expect(service.saveTencentCloudContext(input)).rejects.toThrow('可用区未通过云端校验'); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it.each([{ zoneId: 'ap-beijing-1' }, { regionId: '../bad' }, { accessKeySecret: '********' }, { accessKeySecret: '' }, { accessKeyId: '' }, { provider: 'alibaba_cloud' }, { imageImportBucket: 'not-supported' }])('rejects invalid explicit inputs before cloud or database writes %j', async (patch) => {
    const { db, service } = fixture(); const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.saveTencentCloudContext({ ...input, ...patch } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it('rejects a Tencent provider sent to the Alibaba save path before reading identity', async () => {
    const { db, service } = fixture(); const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.saveFromCloudConfig({ provider: 'tencent_cloud', defaultRegion: input.regionId, defaultZoneId: input.zoneId, accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret })).rejects.toThrow('不能写入阿里云');
    expect(fetch).not.toHaveBeenCalled(); expect(db.systemCloudConfig.upsert).not.toHaveBeenCalled();
  });
});
