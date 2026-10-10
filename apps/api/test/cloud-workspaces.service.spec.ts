import { CloudWorkspacesService } from '../src/admin/cloud-workspaces.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const manager = { id: 'manager', username: 'admin', role: 'admin' as const, isPlatformManager: true, cloudWorkspaceId: null };
const member = { id: 'member-a', username: 'operator', role: 'admin' as const, cloudWorkspaceId: 'space-a', isPlatformManager: false };
function fixture() {
  const spaces = [{ id: 'space-a', provider: 'alibaba_cloud', accountUid: '111', displayName: '训练阿里账号', isReadOnly: false, activeCloudAccountContextId: 'context-a' },
    { id: 'space-b', provider: 'tencent_cloud', accountUid: '222', displayName: '训练腾讯账号', isReadOnly: false, activeCloudAccountContextId: 'context-b' }];
  const contexts = spaces.map((space, index) => ({ id: space.activeCloudAccountContextId, cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid, displayName: '训练地域', regionId: index ? 'ap-nanjing' : 'cn-hangzhou', zoneId: index ? 'ap-nanjing-1' : 'cn-hangzhou-h', isActive: false, status: 'ready', imageImportBucket: '', bucketStatus: 'unconfigured', lastVerifiedAt: null, accessKeyId: 'private-key', accessKeySecret: 'private-secret' }));
  const users = new Map([['manager', { selectedCloudWorkspaceId: 'space-a' }]]);
  const db = { cloudWorkspace: { findMany: jest.fn(async ({ where }) => spaces.filter(space => !where.id || space.id === where.id)), findUnique: jest.fn(async ({ where }) => spaces.find(space => space.id === where.id) ?? null), findUniqueOrThrow: jest.fn(async ({ where }) => { const space = spaces.find(space => space.id === where.id); if (!space) throw new Error('missing'); return space; }) },
    cloudAccountContext: { findMany: jest.fn(async ({ where }) => contexts.filter(context => context.cloudWorkspaceId === where.cloudWorkspaceId)), findFirst: jest.fn(async () => contexts[0]), findUnique: jest.fn(async ({ where }) => contexts.find(context => context.id === where.id)) },
    platformUser: { findUnique: jest.fn(async ({ where }) => users.get(where.id)), update: jest.fn(async ({ where, data }) => { users.set(where.id, data); return data; }) } };
  return { service: new CloudWorkspacesService(db as never), db, contexts, spaces };
}
describe('cloud account workspace metadata and selection', () => {
  it('keeps account data and encrypted credentials intact through A -> B -> A selection', async () => {
    const { service, db, contexts, spaces } = fixture(); const originalContexts = structuredClone(contexts); const originalSpaces = structuredClone(spaces);
    expect((await service.current(manager)).id).toBe('space-a');
    expect((await service.switch(manager, 'space-b')).id).toBe('space-b');
    expect((await service.current(manager)).id).toBe('space-b');
    expect((await service.switch(manager, 'space-a')).id).toBe('space-a');
    expect(contexts).toEqual(originalContexts); expect(spaces).toEqual(originalSpaces);
    expect(db.platformUser.update).toHaveBeenCalledTimes(2);
    const listed = await service.list(manager); expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('private-key'); expect(JSON.stringify(listed)).not.toContain('private-secret');
    expect(listed[0].capabilities.provisioning).toBe(true); expect(listed[1].capabilities.provisioning).toBe(true);
    expect(listed[0].capabilities.rangeProvisioning).toBe(true);
    expect(listed[1].capabilities.billingSync).toBe(true);
  });
  it('keeps Tencent NAT range launch closed until explicit controlled validation is enabled', async () => {
    const original = process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
    try {
      delete process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
      const { service } = fixture();
      const closed = (await service.list(manager))[1].capabilities;
      expect(closed).toMatchObject({ provisioning: true, rangeProvisioning: false, billingSync: true, imageImport: true });
      process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = '1';
      expect((await service.list(manager))[1].capabilities.rangeProvisioning).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
      else process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = original;
    }
  });
  it('does not elevate a workspace administrator into a platform manager or fall back from a bad ID', async () => {
    const { service, db } = fixture(); expect((await service.list(member)).map(space => space.id)).toEqual(['space-a']);
    await expect(service.switch(member, 'space-b')).rejects.toThrow('无权访问');
    await expect(service.current(manager, 'missing-space')).rejects.toThrow('不存在');
    await expect(service.current(manager, ' ')).rejects.toThrow('标识无效');
    expect(db.platformUser.update).not.toHaveBeenCalled();
  });
  it('selects the exact workspace context even when a different global account flag is inactive, and rejects contradictions', async () => {
    const { service, contexts } = fixture();
    const scope = { cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud' as const, accountUid: '111', actorUserId: 'manager', isReadOnly: false };
    await expect(runInCloudWorkspace(scope, () => service.selectedAccountContextId())).resolves.toBe('context-a');
    contexts[0].accountUid = '222';
    await expect(runInCloudWorkspace(scope, () => service.selectedAccountContextId())).rejects.toThrow('配置与当前工作空间不一致');
  });
});
