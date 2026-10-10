import { randomUUID } from 'node:crypto';
import type { AdminRepository, CreateRangeTemplateFromInstanceInput } from '../src/admin/admin.repository';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const dbUrl = process.env.TEMPLATE_COPY_TEST_DATABASE_URL;
for (const mode of ['memory', 'postgres'] as const) {
 const suite = mode === 'memory' || dbUrl ? describe : describe.skip;
 suite(`atomic runtime template copy (${mode})`, () => {
  let repository: AdminRepository; let prisma: PrismaService | undefined; let scope: { cloudWorkspaceId: string; provider: 'alibaba_cloud'; accountUid: string };
  beforeEach(async () => {
   scope = { cloudWorkspaceId: `copy-${randomUUID()}`, provider: 'alibaba_cloud', accountUid: 'fixture' };
   if (mode === 'memory') repository = createMemoryAdminRepository();
   else { prisma = new PrismaService({ datasourceUrl: dbUrl }); await prisma.$connect(); repository = new PrismaAdminRepository(prisma); await runInSystemCloudWorkspaceScope(() => prisma!.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated test' } })); }
  });
  afterEach(async () => {
   if (prisma) { await runInSystemCloudWorkspaceScope(async () => {
    await prisma!.idempotentOperation.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma!.rangeInstance.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma!.rangeTemplate.updateMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId }, data: { currentDraftVersionId: null } });
    await prisma!.rangeTemplateVersion.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma!.rangeTemplate.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma!.platformUser.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma!.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } });
   }); await prisma.$disconnect(); prisma = undefined; }
  });
  const run = <T>(fn: () => T) => runInCloudWorkspace(scope, fn);
  async function input(): Promise<CreateRangeTemplateFromInstanceInput> {
   if (prisma) await prisma.platformUser.create({ data: { id: 'owner', username: 'owner', loginUsername: `owner-${scope.cloudWorkspaceId}`, passwordHash: 'fixture', role: 'user' } });
   const original = await repository.createRangeTemplate({ name: 'source', slug: randomUUID(), version: 'v1', ownerUserId: 'owner', modulePathOrRef: 'fixture', topologySpec: {} as any });
   const instance = await repository.createRangeInstance({ name: 'running', ownerUserId: 'owner', status: 'running', instanceMode: 'range', templateId: original.id, draftRevision: 4, draftTopologyGraph: { nodes: [] }, draftTopologySpec: {}, draftScenarioTemplateSpec: {}, draftCompiledProvisionSpec: {} });
   return { rangeInstanceId: instance.id, expectedDraftRevision: 4, actorUserId: 'owner', isAdmin: false, idempotencyKey: 'stable', argumentsHash: 'fixed-request', operationId: randomUUID(), template: { name: 'copy', slug: randomUUID(), version: 'v1', createdBy: 'owner', ownerUserId: 'owner', visibility: 'private', cloudProvider: 'alibaba_cloud', modulePathOrRef: 'fixture', topologySpec: {} as any, topologyGraph: { nodes: [] } } };
  }
  it('commits the new template, draft version and replay receipt atomically', () => run(async () => {
   const payload = await input(); const result = await repository.createRangeTemplateFromInstance(payload);
   expect(result).toMatchObject({ visibility: 'private', sourceDraftRevision: 4 });
   const created = await repository.getRangeTemplateById(result!.templateId); expect(created?.currentDraftVersion?.templateId).toBe(result!.templateId);
   expect(await repository.getIdempotentOperation('owner', 'range_instance_save_as_template', 'stable')).toMatchObject({ status: 'succeeded', result });
   await repository.updateRangeInstance(payload.rangeInstanceId, { draftRevision: 5, draftTopologyGraph: null });
   expect(await repository.createRangeTemplateFromInstance(payload)).toEqual(result); expect(await repository.listRangeTemplates()).toHaveLength(2);
  }));
  it('produces one template under simultaneous identical submissions', () => run(async () => {
   const payload = await input(); const results = await Promise.allSettled([repository.createRangeTemplateFromInstance(payload), repository.createRangeTemplateFromInstance({ ...payload, operationId: randomUUID() })]);
   expect(results.some(result => result.status === 'fulfilled' && result.value)).toBe(true);
   const replay = await repository.createRangeTemplateFromInstance(payload);
   expect(await repository.listRangeTemplates()).toHaveLength(2); expect(replay?.templateId).toBeTruthy();
  }));
  it.each(['revision', 'owner', 'workspace'] as const)('rejects changed %s without orphaned template/version/receipt', async cause => {
   const payload = await run(input);
   const execute = async () => {
    if (cause === 'revision') await repository.updateRangeInstance(payload.rangeInstanceId, { draftRevision: 6 });
    const result = await repository.createRangeTemplateFromInstance({ ...payload, ...(cause === 'owner' ? { actorUserId: 'intruder' } : {}) });
    expect(result).toBeNull(); expect(await repository.getIdempotentOperation(payload.actorUserId, 'range_instance_save_as_template', 'stable')).toBeNull();
   };
   if (cause === 'workspace') await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'other-space' }, execute); else await run(execute);
   await run(async () => { expect(await repository.listRangeTemplates()).toHaveLength(1); if (prisma) expect(await prisma.rangeTemplateVersion.count()).toBe(1); });
  });
 });
}
