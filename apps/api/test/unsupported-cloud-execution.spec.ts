import { imageRpc } from '../src/admin/aliyun-image-rpc';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import type { RangeInstanceRecord } from '../src/admin/admin.repository';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { PackedImagesService } from '../src/admin/packed-images.service';

describe('Unsupported cloud execution fences', () => {
  const account = { provider: 'tencent_cloud', accountUid: '100001', cloudAccountContextId: 'tc-context', defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', accountUidResolved: true, imageImportBucket: '' };
  let fetch: jest.SpyInstance;
  beforeEach(() => { fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected cloud request')); });
  afterEach(() => jest.restoreAllMocks());

  it('blocks unverified Tencent instances before reading any account credentials', async () => {
    const getAccountContextById = jest.fn();
    const service = new SingleInstanceBatchExecutionService({} as never, { getAccountContextById } as never);
    await expect(service.resolveInstanceAccount({ cloudProvider: 'tencent_cloud' } as RangeInstanceRecord)).rejects.toThrow('完整冻结');
    expect(getAccountContextById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks an Alibaba instance bound to a Tencent account even when the UID matches', async () => {
    const getAccountContextById = jest.fn().mockResolvedValue(account);
    const service = new SingleInstanceBatchExecutionService({} as never, { getAccountContextById } as never);
    await expect(service.resolveInstanceAccount({ cloudProvider: 'alibaba_cloud', singleInstanceConfig: { cloudAccountContextId: 'tc-context', cloudAccountUid: account.accountUid } } as RangeInstanceRecord)).rejects.toThrow('厂商');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not create or persist a network for an unknown provider', async () => {
    const bootstrapDefaultProfile = jest.fn();
    const getSingleInstanceNetworkProfile = jest.fn();
    const service = new SingleInstanceNetworkService({ getSingleInstanceNetworkProfile } as never, {} as never,
      { bootstrapDefaultProfile } as never, { serialize: async (work: () => unknown) => work() } as never);
    await expect(service.ensureDefaultProfile({ ...account, provider: 'unknown_cloud' } as never)).rejects.toThrow('尚未开放');
    expect(bootstrapDefaultProfile).not.toHaveBeenCalled();
    expect(getSingleInstanceNetworkProfile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['tencent_cloud', 'unknown_cloud'])('never sends %s image credentials to Alibaba', async (provider) => {
    await expect(imageRpc({ ...account, provider, regionId: account.defaultRegion }, 'CreateImage')).rejects.toThrow('尚未适配');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a missing Tencent physical node without any cloud operation', async () => {
    const getRangeInstanceById = jest.fn().mockResolvedValue({ id: 'tc-range', cloudProvider: 'tencent_cloud', ownerUserId: 'owner' });
    const service = new RangeInstanceNodeActionsService({ getRangeInstanceById } as never, {} as never, {} as never);
    await expect(service.run('tc-range', 'host', 'reboot', {}, { id: 'owner', role: 'user' })).rejects.toThrow('host node not found');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never submits an Alibaba image pack using a verified Tencent account', async () => {
    const createPackedImageArtifact = jest.fn();
    const service = new PackedImagesService({ createPackedImageArtifact, getRangeInstanceById: async () => null } as never, {} as never);
    await expect(service.begin({ cloudAccountContextId: 'tc-context', cloudAccountUid: account.accountUid, regionId: account.defaultRegion, ownerUserId: 'owner', sourceRangeInstanceId: 'range', sourceHostKey: 'host', sourceInstanceId: 'ins-existing' }, { ...account, id: 'tc-context', regionId: account.defaultRegion, zoneId: account.defaultZoneId, status: 'ready' } as never)).rejects.toThrow('源实例缺少冻结');
    expect(createPackedImageArtifact).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
