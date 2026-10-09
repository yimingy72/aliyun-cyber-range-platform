import { getCurrentCloudWorkspaceId, getCurrentCloudWorkspaceScope, runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { scopePrismaQuery, scopePrismaResult } from '../src/database/prisma-workspace-scope';

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

  it.each(['BillingLineItem', 'BillingAnomaly'])('scopes provider-specific billing fingerprints for %s', model => {
    expect(scopePrismaQuery(model, 'findUnique', { where: { cloudProvider_sourceFingerprint: { cloudProvider: 'alibaba_cloud', sourceFingerprint: 'same-source' } } }, scope).where)
      .toEqual({ cloudWorkspaceId: scope.cloudWorkspaceId, cloudWorkspaceId_cloudProvider_sourceFingerprint: { cloudWorkspaceId: scope.cloudWorkspaceId, cloudProvider: 'alibaba_cloud', sourceFingerprint: 'same-source' } });
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
      data: { tags: { deleteMany: { cloudWorkspaceId: scope.cloudWorkspaceId }, create: [{ cloudWorkspace: { connect: { id: scope.cloudWorkspaceId } }, tag: { connect: { id: 'other-tag', cloudWorkspaceId: scope.cloudWorkspaceId } } }] } },
      include: { ownerUser: { where: { cloudWorkspaceId: scope.cloudWorkspaceId }, select: { username: true } }, tags: { where: { cloudWorkspaceId: scope.cloudWorkspaceId }, include: { tag: {} } } },
    });
  });

  it('hides required historical cross-workspace profiles and removes internal scope fields', () => {
    const selection = { include: { ownerUser: { select: { username: true } } } };
    expect(scopePrismaResult('ImageImportJob', { ownerUser: { username: 'secret-other-user', cloudWorkspaceId: 'other' } }, selection, scope)).toEqual({ ownerUser: null });
    expect(scopePrismaResult('ImageImportJob', { ownerUser: { username: 'alice', cloudWorkspaceId: scope.cloudWorkspaceId } }, selection, scope)).toEqual({ ownerUser: { username: 'alice' } });
  });

  it('keeps historical resources read-only but permits audit and confirmation records', () => {
    const history = { ...scope, isReadOnly: true };
    expect(() => scopePrismaQuery('RangeTemplate', 'create', { data: { name: 'new' } }, history)).toThrow('read-only');
    expect(scopePrismaQuery('OperationAuditEvent', 'create', { data: { phase: 'requested' } }, history).data.cloudWorkspaceId).toBe(scope.cloudWorkspaceId);
    expect(scopePrismaQuery('RangeInstance', 'findMany', {}, history).where.cloudWorkspaceId).toBe(scope.cloudWorkspaceId);
  });
});
