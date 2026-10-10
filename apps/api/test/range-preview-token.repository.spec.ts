import { randomUUID } from 'node:crypto';
import type { AdminRepository, ApplyRangeInstanceDraftInput, RangeInstanceRecord } from '../src/admin/admin.repository';
import { rangeDraftSourceDigest } from '../src/admin/range-draft-change-policy';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const url = process.env.RUNTIME_PREVIEW_TEST_DATABASE_URL;
for (const mode of ['memory', 'postgres'] as const) {
 const suite = mode === 'memory' || url ? describe : describe.skip;
 suite(`atomic preview token + update admission (${mode})`, () => {
  let repository: AdminRepository; let prisma: PrismaService | undefined; let scope: { cloudWorkspaceId: string; provider: 'alibaba_cloud'; accountUid: string };
  beforeEach(async () => {
   scope = { cloudWorkspaceId: `preview-${randomUUID()}`, provider: 'alibaba_cloud', accountUid: 'fixture' };
   if (mode === 'memory') repository = createMemoryAdminRepository();
   else { prisma = new PrismaService({ datasourceUrl: url }); await prisma.$connect(); repository = new PrismaAdminRepository(prisma); await runInSystemCloudWorkspaceScope(() => prisma!.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated preview test' } })); }
  });
  afterEach(async () => { if (prisma) { await runInSystemCloudWorkspaceScope(async () => { await prisma!.operationConfirmation.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } }); await prisma!.rangeInstance.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } }); await prisma!.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } }); }); await prisma.$disconnect(); prisma = undefined; } });
  const run = <T>(work: () => T) => runInCloudWorkspace(scope, work);
  async function fixture() {
   const instance = await repository.createRangeInstance({ name: 'running fixture', status: 'running', instanceMode: 'range', expiresAt: '2099-01-01T00:00:00Z', draftRevision: 1, runtimeTopologyGraph: { nodes: [] }, runtimeCompiledProvisionSpec: {}, draftTopologyGraph: { nodes: [] }, draftTopologySpec: {}, draftScenarioTemplateSpec: {}, draftCompiledProvisionSpec: {} });
   const expectedSourceDigest = rangeDraftSourceDigest(instance, 'actor', scope.cloudWorkspaceId);
   const preview = await repository.createOperationConfirmation({ actorUserId: 'actor', oauthClientId: 'range-preview', toolName: 'range_instance_topology_preview', argumentsHash: expectedSourceDigest, targetSnapshot: { rangeInstanceId: instance.id }, idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 300_000) });
   const input: ApplyRangeInstanceDraftInput = { rangeInstanceId: instance.id, expectedDraftRevision: 1, triggeredBy: 'actor', previewToken: preview.id, expectedSourceDigest, topologySnapshot: { operation: 'update', draftRevision: 1, topologyGraph: { nodes: [] }, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: 'fixture' } };
   return { instance, preview, input };
  }
  it('allows one concurrent enqueue and consumes exactly its preview', () => run(async () => {
   const f = await fixture(); const results = await Promise.allSettled([repository.applyRangeInstanceDraft(f.input), repository.applyRangeInstanceDraft(f.input)]);
   expect(results.filter(result => result.status === 'fulfilled' && result.value)).toHaveLength(1);
   expect(await repository.listProvisionJobs()).toHaveLength(1); expect(Number.isFinite((await repository.getOperationConfirmationById(f.preview.id))!.consumedAt!.getTime())).toBe(true);
  }));
  it.each(['resource', 'expiry', 'actor', 'expired-token'] as const)('rejects stale %s without consuming token or creating orphan job', cause => run(async () => {
   const f = await fixture();
   if (cause === 'resource') await repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', hostIds: { entry: 'i-changed' } } });
   if (cause === 'expiry') await repository.updateRangeInstance(f.instance.id, { expiresAt: new Date('2098-01-01') });
   if (cause === 'expired-token') {
    // A fresh expired receipt is valid test input; no mutation of a live database is used.
    const receipt = await repository.createOperationConfirmation({ actorUserId: 'actor', oauthClientId: 'range-preview', toolName: 'range_instance_topology_preview', argumentsHash: f.input.expectedSourceDigest, targetSnapshot: null, idempotencyKey: randomUUID(), expiresAt: new Date(0) }); f.input.previewToken = receipt.id;
   }
   const outcome = await Promise.allSettled([repository.applyRangeInstanceDraft({ ...f.input, ...(cause === 'actor' ? { triggeredBy: 'other' } : {}) })]);
   expect(outcome[0].status === 'rejected' || outcome[0].status === 'fulfilled' && outcome[0].value === null).toBe(true);
   expect(await repository.listProvisionJobs()).toHaveLength(0); expect((await repository.getOperationConfirmationById(f.preview.id))!.consumedAt).toBeNull();
  }));
 });
}
