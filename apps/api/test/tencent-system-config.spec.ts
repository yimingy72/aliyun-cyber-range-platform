import { SystemConfigService } from '../src/admin/system-config.service';

const context = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'tencent-context', accountUid: '100001', accountUidResolved: true, defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '' };
const item = { Zone: context.defaultZoneId, InstanceType: 'S5.MEDIUM4', InstanceFamily: 'S5', InstanceChargeType: 'POSTPAID_BY_HOUR', Status: 'SELL', Cpu: 2, Memory: 4, CpuType: 'Intel Xeon Cascade Lake' };
const json = (value: unknown) => new Response(JSON.stringify({ Response: { RequestId: 'synthetic-request', ...(value as object) } }));
describe('Tencent Cloud context catalog and global configuration boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it('queries live saleable types in the bound zone rather than the Alibaba preferred type list', async () => {
    const service = new SystemConfigService({} as never, {} as never);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ InstanceTypeQuotaSet: [
      item, { ...item, InstanceType: 'S5.MEDIUM8', Memory: 8 },
      { ...item, InstanceType: 'S6.MEDIUM4', Status: 'SOLD_OUT' },
      { ...item, InstanceType: 'S7.MEDIUM4', InstanceChargeType: 'PREPAID' },
      { ...item, InstanceType: 'S8.MEDIUM4', Zone: 'ap-beijing-1' },
      { ...item, InstanceType: 'SA3.MEDIUM4', CpuType: 'AMD EPYC Milan', InstanceFamily: 'SA3' },
      { ...item, InstanceType: 'SR1.MEDIUM4', CpuType: 'Ampere Altra', InstanceFamily: 'SR1' },
      { ...item, InstanceType: 'U1.MEDIUM4', CpuType: undefined, InstanceFamily: 'U1' },
    ] }));
    await expect(service.getInstanceTypeAvailabilityInContext({ cpu: 2, memory: 4 }, context)).resolves.toMatchObject({
      exactAvailable: true, matches: [
        expect.objectContaining({ instanceTypeId: 'S5.MEDIUM4', architecture: 'X86_64', generation: '' }),
        expect.objectContaining({ instanceTypeId: 'SA3.MEDIUM4', architecture: 'X86_64' }),
        expect.objectContaining({ instanceTypeId: 'SR1.MEDIUM4', architecture: 'ARM64' }),
        expect.objectContaining({ instanceTypeId: 'U1.MEDIUM4', architecture: 'UNKNOWN' }),
      ], warning: expect.stringContaining('创建前会再次校验'),
    });
    expect(fetch).toHaveBeenCalledWith('https://cvm.tencentcloudapi.com/', expect.objectContaining({
      body: JSON.stringify({ Filters: [{ Name: 'zone', Values: [context.defaultZoneId] }, { Name: 'instance-charge-type', Values: ['POSTPAID_BY_HOUR'] }] }),
      headers: expect.objectContaining({ 'X-TC-Action': 'DescribeZoneInstanceConfigInfos', 'X-TC-Region': context.defaultRegion }),
    }));
  });
  it.each([false, true])('reports only launchable x86 specs in the public availability response (x86 present: %s)', async x86Available => {
    const service = new SystemConfigService({} as never, {} as never);
    jest.spyOn(service, 'getSelectedAccountContext').mockResolvedValue(context);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ InstanceTypeQuotaSet: [
      ...(x86Available ? [item] : []),
      { ...item, InstanceType: 'SR1.MEDIUM4', CpuType: 'Ampere Altra' },
      { ...item, InstanceType: 'U1.MEDIUM4', CpuType: undefined },
    ] }));
    const available = await service.getInstanceTypeAvailability({ cpu: 2, memory: 4 });
    expect(available.exactAvailable).toBe(x86Available);
    expect(available.matches.map(match => match.instanceTypeId)).toEqual(x86Available ? ['S5.MEDIUM4'] : []);
    expect(available.warning).toContain(x86Available ? '创建前会再次校验' : '平台暂不支持 ARM 或未知架构');
  });
  it('preserves the Alibaba availability response unchanged', async () => {
    const service = new SystemConfigService({} as never, {} as never);
    const alibaba = { ...context, provider: 'alibaba_cloud' as const, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' };
    const availability = { cpu: 2, memory: 4, regionId: alibaba.defaultRegion, zoneId: alibaba.defaultZoneId, exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.c7.large', cpu: 2, memoryGiB: 4, family: 'ecs.c7', generation: '7', architecture: 'X86' }], warning: null };
    jest.spyOn(service, 'getSelectedAccountContext').mockResolvedValue(alibaba);
    jest.spyOn(service, 'getInstanceTypeAvailabilityInContext').mockResolvedValue(availability);
    expect(await service.getInstanceTypeAvailability({ cpu: 2, memory: 4 })).toBe(availability);
  });
  it('returns unavailable rather than an invented type when the exact shape is absent', async () => {
    const service = new SystemConfigService({} as never, {} as never);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ InstanceTypeQuotaSet: [item] }));
    await expect(service.getInstanceTypeAvailabilityInContext({ cpu: 4, memory: 8 }, context)).resolves.toMatchObject({ exactAvailable: false, matches: [] });
  });
  it.each([{}, { InstanceTypeQuotaSet: null }, { InstanceTypeQuotaSet: [null] }, { InstanceTypeQuotaSet: [{ ...item, InstanceType: '' }] }])('rejects malformed inventory %j', async (payload) => {
    const service = new SystemConfigService({} as never, {} as never);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json(payload));
    await expect(service.getInstanceTypeAvailabilityInContext({ cpu: 2, memory: 4 }, context)).rejects.toThrow('响应');
  });
  it('refuses Tencent global updates before reading or copying existing Alibaba credentials', async () => {
    const db = { cloudAccountContext: { findFirst: jest.fn() }, systemCloudConfig: { upsert: jest.fn() } };
    const contexts = { saveFromCloudConfig: jest.fn() };
    const service = new SystemConfigService(db as never, contexts as never);
    await expect(service.updateSnapshot({ provider: 'tencent_cloud', defaultRegion: context.defaultRegion })).rejects.toThrow('暂不能启用为全局账号');
    expect(db.cloudAccountContext.findFirst).not.toHaveBeenCalled(); expect(db.systemCloudConfig.upsert).not.toHaveBeenCalled(); expect(contexts.saveFromCloudConfig).not.toHaveBeenCalled();
  });
  it('preserves Tencent provider in a directly selected context without changing process Alibaba env', async () => {
    const service = new SystemConfigService({} as never, { getCredentials: jest.fn().mockResolvedValue({ id: context.cloudAccountContextId, provider: context.provider, regionId: context.defaultRegion, zoneId: context.defaultZoneId, accountUid: context.accountUid, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, imageImportBucket: '' }) } as never);
    const priorRegion = process.env.ALICLOUD_REGION;
    await expect(service.getAccountContextById(context.cloudAccountContextId)).resolves.toEqual(context);
    expect(process.env.ALICLOUD_REGION).toBe(priorRegion);
  });
  it('rejects an erroneously active Tencent context rather than rewriting its provider and leaking into Alibaba env', async () => {
    const service = new SystemConfigService({ cloudAccountContext: { findFirst: jest.fn().mockResolvedValue({ id: context.cloudAccountContextId, provider: context.provider, regionId: context.defaultRegion, zoneId: context.defaultZoneId, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, imageImportBucket: '' }) } } as never, {} as never);
    const priorRegion = process.env.ALICLOUD_REGION;
    await expect(service.getSnapshot()).rejects.toThrow('尚未开放腾讯云全局活跃配置');
    await expect(service.getAccountContext()).rejects.toThrow('尚未开放腾讯云全局活跃配置');
    expect(process.env.ALICLOUD_REGION).toBe(priorRegion);
  });
});
