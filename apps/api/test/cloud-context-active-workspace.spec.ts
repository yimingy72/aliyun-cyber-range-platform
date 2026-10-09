import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

describe('cloud context flags in an explicitly selected workspace', () => {
  it('reports only the workspace default context as active even when an older global flag disagrees', async () => {
    const row = { cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud', displayName: '训练地域', accountUid: '111', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'fixture-key', accessKeySecret: 'private-secret', imageImportBucket: '', status: 'ready', bucketStatus: 'unconfigured', lastError: null, lastVerifiedAt: null, createdAt: new Date(), updatedAt: new Date() };
    const original = [{ ...row, id: 'old-context', isActive: true }, { ...row, id: 'default-context', regionId: 'cn-beijing', zoneId: 'cn-beijing-k', isActive: false }];
    const db = { cloudAccountContext: { findMany: jest.fn(async () => original) }, cloudWorkspace: { findUnique: jest.fn(async () => ({ id: 'space-a', activeCloudAccountContextId: 'default-context' })) } };
    const service = new CloudAccountContextsService(db as never);
    const result = await runInCloudWorkspace({ cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud', accountUid: '111', actorUserId: 'manager' }, () => service.list());
    expect(result.map(context => [context.id, context.isActive])).toEqual([['old-context', false], ['default-context', true]]);
    expect(original.map(context => context.isActive)).toEqual([true, false]);
    expect(db.cloudAccountContext.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { cloudWorkspaceId: 'space-a', status: 'ready' } }));
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
});
