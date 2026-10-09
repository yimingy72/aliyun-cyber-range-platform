import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const a = { cloudWorkspaceId: 'a', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const b = { cloudWorkspaceId: 'b', provider: 'tencent_cloud' as const, accountUid: '100001' };

describe('memory repository cloud workspaces', () => {
  it('keeps business users and same display usernames apart while preserving the global manager', async () => {
    const repo = createMemoryAdminRepository();
    await runInSystemCloudWorkspaceScope(() => repo.createPlatformUser({ id: 'root', username: 'root', loginUsername: 'root', passwordHash: 'fixture', role: 'admin', isPlatformManager: true }));
    await runInCloudWorkspace(a, () => repo.createPlatformUser({ id: 'a-alice', username: 'alice', loginUsername: 'alice-a', passwordHash: 'fixture', role: 'user' }));
    await runInCloudWorkspace(b, () => repo.createPlatformUser({ id: 'b-alice', username: 'alice', loginUsername: 'alice-b', passwordHash: 'fixture', role: 'user' }));
    await runInCloudWorkspace(a, async () => {
      expect((await repo.listPlatformUsers()).map(user => user.id)).toEqual(['a-alice']);
      expect(await repo.getPlatformUserById('b-alice')).toBeNull();
      expect(await repo.getPlatformUserByUsername('alice')).toMatchObject({ id: 'a-alice', loginUsername: 'alice-a' });
      expect(await repo.getPlatformUserById('root')).toMatchObject({ isPlatformManager: true });
    });
  });

  it('scopes lists, ID lookup and deletion of instances and templates', async () => {
    const repo = createMemoryAdminRepository();
    const first = await runInCloudWorkspace(a, () => repo.createRangeInstance({ name: 'same-name', cloudProvider: 'alibaba_cloud' }));
    const second = await runInCloudWorkspace(b, () => repo.createRangeInstance({ name: 'same-name', cloudProvider: 'tencent_cloud' }));
    await runInCloudWorkspace(a, async () => {
      expect((await repo.listRangeInstances()).map(instance => instance.id)).toEqual([first.id]);
      expect(await repo.getRangeInstanceById(second.id)).toBeNull();
      await expect(repo.updateRangeInstance(second.id, { status: 'destroyed' })).rejects.toThrow();
    });
    expect(await runInCloudWorkspace(b, () => repo.getRangeInstanceById(second.id))).toMatchObject({ status: 'draft', cloudWorkspaceId: b.cloudWorkspaceId });
  });

  it('keeps confirmation and idempotent results apart after a manager switches workspace', async () => {
    const repo = createMemoryAdminRepository();
    const input = { actorUserId: 'root', toolName: 'test', idempotencyKey: 'same-key', argumentsHash: 'same-input', operationId: 'op-a' };
    const first = await runInCloudWorkspace(a, () => repo.createIdempotentOperation(input));
    const second = await runInCloudWorkspace(b, () => repo.createIdempotentOperation({ ...input, operationId: 'op-b' }));
    expect(first.id).not.toBe(second.id);
    expect(await runInCloudWorkspace(b, () => repo.getIdempotentOperationByOperationId(first.operationId))).toBeNull();
    expect(await runInCloudWorkspace(a, () => repo.getIdempotentOperation('root', 'test', 'same-key'))).toMatchObject({ operationId: 'op-a' });
  });

  it('preserves source account separation even when cloud resource IDs match across providers', async () => {
    const repo = createMemoryAdminRepository();
    const input = { regionId: 'region', cloudResourceId: 'same-cloud-id', cloudResourceType: 'ecs' as const, billingScope: 'platform' as const, billingStartAt: new Date('2026-10-09') };
    const first = await runInCloudWorkspace(a, () => repo.createBillingLedgerResource({ ...input, cloudProvider: 'alibaba_cloud' }));
    const second = await runInCloudWorkspace(b, () => repo.createBillingLedgerResource({ ...input, cloudProvider: 'tencent_cloud' }));
    expect((await runInCloudWorkspace(a, () => repo.listBillingLedgerResources())).map(row => row.id)).toEqual([first.id]);
    expect((await runInCloudWorkspace(b, () => repo.listBillingLedgerResources())).map(row => row.id)).toEqual([second.id]);
  });

  it('rejects historical business writes and records audit evidence', async () => {
    const repo = createMemoryAdminRepository();
    await runInCloudWorkspace({ ...a, isReadOnly: true }, async () => {
      await expect(repo.createRangeInstance({ name: 'forbidden' })).rejects.toThrow('read-only');
      expect(await repo.appendOperationAuditEvent({ operationId: 'op', requestId: 'request', actorUserId: 'root', source: 'web', toolName: 'lookup', phase: 'requested' })).toMatchObject({ cloudWorkspaceId: a.cloudWorkspaceId });
    });
  });
});
