import { getCurrentCloudWorkspaceId, getCurrentCloudWorkspaceScope, runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { scopePrismaQuery } from '../src/database/prisma-workspace-scope';

const scope = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: '100001' };

describe('cloud workspace query boundary', () => {
  it('keeps concurrent async requests in separate workspaces', async () => {
    const outputs = await Promise.all(['a', 'b'].map(id => runInCloudWorkspace({ ...scope, cloudWorkspaceId: id }, async () => {
      await new Promise(resolve => setTimeout(resolve, id === 'a' ? 20 : 2));
      return getCurrentCloudWorkspaceId();
    })));
    expect(outputs).toEqual(['a', 'b']);
    expect(getCurrentCloudWorkspaceScope()).toBeNull();
  });

  it('requires deliberate system scope and restores the caller context', () => {
    runInCloudWorkspace(scope, () => {
      runInSystemCloudWorkspaceScope(() => expect(getCurrentCloudWorkspaceScope()).toEqual({ system: true }));
      expect(getCurrentCloudWorkspaceId()).toBe(scope.cloudWorkspaceId);
    });
  });

  it('fences ID and OR reads even with a forged workspace filter', () => {
    expect(scopePrismaQuery('RangeInstance', 'findUnique', { where: { id: 'instance-b', cloudWorkspaceId: 'workspace-b', OR: [{ cloudWorkspaceId: 'workspace-b' }] } }, scope).where)
      .toEqual({ id: 'instance-b', cloudWorkspaceId: 'workspace-a', OR: [{ cloudWorkspaceId: 'workspace-b' }] });
  });

  it('keeps normal filters scalar but scopes compound unique selectors', () => {
    expect(scopePrismaQuery('PlatformImageTag', 'findMany', { where: { normalizedName: 'linux' } }, scope).where)
      .toEqual({ normalizedName: 'linux', cloudWorkspaceId: scope.cloudWorkspaceId });
    expect(scopePrismaQuery('PlatformImageTag', 'upsert', { where: { normalizedName: 'linux' }, create: { name: 'Linux', normalizedName: 'linux' }, update: {} }, scope).where)
      .toEqual({ cloudWorkspaceId: scope.cloudWorkspaceId, cloudWorkspaceId_normalizedName: { cloudWorkspaceId: scope.cloudWorkspaceId, normalizedName: 'linux' } });
  });

  it('stamps every createMany row and rejects writes that move resources', () => {
    expect(scopePrismaQuery('RangeInstance', 'createMany', { data: [{ name: 'one' }, { name: 'two' }] }, scope).data)
      .toEqual([{ name: 'one', cloudWorkspaceId: scope.cloudWorkspaceId }, { name: 'two', cloudWorkspaceId: scope.cloudWorkspaceId }]);
    expect(() => scopePrismaQuery('RangeInstance', 'update', { where: { id: 'one' }, data: { cloudWorkspaceId: 'workspace-b' } }, scope)).toThrow('cannot move');
  });

  it('rejects provider and account source mismatches without rewriting them', () => {
    expect(() => scopePrismaQuery('PlatformImageAsset', 'create', { data: { provider: 'tencent_cloud', accountUid: scope.accountUid } }, scope)).toThrow('provider does not match');
    expect(() => scopePrismaQuery('BillingLedgerResource', 'create', { data: { cloudAccountUid: '100002' } }, scope)).toThrow('account does not match');
  });

  it('scopes nested reads and tag changes without adding profile data', () => {
    expect(scopePrismaQuery('PlatformImageAsset', 'update', {
      where: { id: 'image' }, data: { tags: { deleteMany: {}, create: [{ tag: { connect: { id: 'other-tag' } } }] } },
      include: { ownerUser: { select: { username: true } }, tags: { include: { tag: true } } },
    }, scope)).toMatchObject({
      data: { tags: { deleteMany: { cloudWorkspaceId: scope.cloudWorkspaceId }, create: [{ cloudWorkspaceId: scope.cloudWorkspaceId, tag: { connect: { id: 'other-tag', cloudWorkspaceId: scope.cloudWorkspaceId } } }] } },
      include: { ownerUser: { where: { cloudWorkspaceId: scope.cloudWorkspaceId }, select: { username: true } }, tags: { where: { cloudWorkspaceId: scope.cloudWorkspaceId }, include: { tag: { where: { cloudWorkspaceId: scope.cloudWorkspaceId } } } } },
    });
  });

  it('keeps historical resources read-only but permits audit and confirmation records', () => {
    const history = { ...scope, isReadOnly: true };
    expect(() => scopePrismaQuery('RangeTemplate', 'create', { data: { name: 'new' } }, history)).toThrow('read-only');
    expect(scopePrismaQuery('OperationAuditEvent', 'create', { data: { phase: 'requested' } }, history).data.cloudWorkspaceId).toBe(scope.cloudWorkspaceId);
    expect(scopePrismaQuery('RangeInstance', 'findMany', {}, history).where.cloudWorkspaceId).toBe(scope.cloudWorkspaceId);
  });
});
