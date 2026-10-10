import { SystemConfigService, type SystemCloudAccountContext } from '../src/admin/system-config.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const tencent: SystemCloudAccountContext = {
  provider: 'tencent_cloud', cloudAccountContextId: 'context-frozen', accountUid: '123', accountUidResolved: true,
  defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret', imageImportBucket: '',
};
const space = { cloudWorkspaceId: 'workspace-tencent', provider: 'tencent_cloud' as const, accountUid: '123', isReadOnly: false };
const fixture = () => {
  const service = new SystemConfigService({} as never, {} as never);
  jest.spyOn(service, 'getSelectedAccountContext').mockResolvedValue({ ...tencent, cloudAccountContextId: 'context-current' });
  jest.spyOn(service, 'getAccountContextById').mockResolvedValue(tencent);
  return service;
};

describe('verified cloud execution account', () => {
  it('uses the frozen context instead of a newer selected region', async () => {
    const service = fixture();
    await expect(runInCloudWorkspace(space, () => service.getExecutionAccountContext({ cloudAccountContextId: 'context-frozen' }))).resolves.toEqual(tencent);
    expect(service.getSelectedAccountContext).not.toHaveBeenCalled();
  });
  it('selects the verified current Tencent context only for a new request', async () => {
    const service = fixture();
    await expect(runInCloudWorkspace(space, () => service.getExecutionAccountContext())).resolves.toMatchObject({ provider: 'tencent_cloud', cloudAccountContextId: 'context-current' });
  });
  it.each([null, '', '   '])('rejects missing frozen context %s without selecting another account', async (id) => {
    const service = fixture();
    await expect(runInCloudWorkspace(space, () => service.getExecutionAccountContext({ cloudAccountContextId: id }))).rejects.toThrow('冻结账号');
    expect(service.getSelectedAccountContext).not.toHaveBeenCalled();
    expect(service.getAccountContextById).not.toHaveBeenCalled();
  });
  it('rejects a frozen context from another provider or main account', async () => {
    const service = fixture();
    await expect(runInCloudWorkspace({ ...space, provider: 'alibaba_cloud' }, () => service.getExecutionAccountContext({ cloudAccountContextId: 'context-frozen' }))).rejects.toThrow('不一致');
    await expect(runInCloudWorkspace({ ...space, accountUid: '456' }, () => service.getExecutionAccountContext({ cloudAccountContextId: 'context-frozen' }))).rejects.toThrow('不一致');
  });
  it('refuses unverified source and read-only history before cloud execution', async () => {
    const service = fixture();
    await expect(runInCloudWorkspace({ ...space, isReadOnly: true }, () => service.getExecutionAccountContext())).rejects.toThrow('历史');
    jest.spyOn(service, 'getSelectedAccountContext').mockResolvedValue({ ...tencent, accountUidResolved: false });
    await expect(runInCloudWorkspace(space, () => service.getExecutionAccountContext())).rejects.toThrow('已验证');
  });
});
