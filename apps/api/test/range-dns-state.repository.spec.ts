import type { AdminRepository, RangeResourceSummary } from '../src/admin/admin.repository';
import type { RangeDnsVerification } from '../src/admin/range-dns-types';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const scopes = [
  { cloudWorkspaceId: 'dns-cas-test-a', provider: 'alibaba_cloud' as const, accountUid: '100001' },
  { cloudWorkspaceId: 'dns-cas-test-b', provider: 'tencent_cloud' as const, accountUid: '100001' },
];
function entry(instanceId = 'ins-host', claimId = 'claim-1', status: RangeDnsVerification['status'] = 'checking'): RangeDnsVerification {
  return { instanceId, claimId, status, method: 'readback', expected: [{ nicId: 'nic-1', privateIp: '10.0.0.10', servers: ['10.0.0.1'] }], actual: [], resolutionStatus: 'not_requested', policyHash: 'fixture-policy', expiresAt: '2099-01-01T00:00:00Z' };
}
const url = process.env.DNS_STATE_TEST_DATABASE_URL ?? process.env.WORKSPACE_TEST_DATABASE_URL;
for (const mode of ['memory', 'postgres'] as const) {
  const suite = mode === 'memory' || url ? describe : describe.skip;
  suite(`atomic guest DNS state (${mode})`, () => {
    let repository: AdminRepository;
    let second: AdminRepository;
    let firstPrisma: PrismaService | undefined;
    let secondPrisma: PrismaService | undefined;
    beforeAll(async () => {
      if (mode !== 'postgres') return;
      firstPrisma = new PrismaService({ datasourceUrl: url });
      secondPrisma = new PrismaService({ datasourceUrl: url });
      await runInSystemCloudWorkspaceScope(async () => {
        await firstPrisma!.rangeInstance.deleteMany({ where: { cloudWorkspaceId: { in: scopes.map((scope) => scope.cloudWorkspaceId) } } });
        for (const { cloudWorkspaceId, ...identity } of scopes) {
          await firstPrisma!.cloudWorkspace.upsert({ where: { id: cloudWorkspaceId }, create: { id: cloudWorkspaceId, ...identity, displayName: cloudWorkspaceId }, update: {} });
        }
      });
    });
    beforeEach(() => {
      repository = mode === 'memory' ? createMemoryAdminRepository() : new PrismaAdminRepository(firstPrisma!);
      second = mode === 'memory' ? repository : new PrismaAdminRepository(secondPrisma!);
    });
    afterEach(async () => {
      if (mode === 'postgres') await runInSystemCloudWorkspaceScope(() => firstPrisma!.rangeInstance.deleteMany({ where: { cloudWorkspaceId: { in: scopes.map((scope) => scope.cloudWorkspaceId) } } }));
    });
    afterAll(async () => {
      if (mode !== 'postgres') return;
      await runInSystemCloudWorkspaceScope(() => firstPrisma!.cloudWorkspace.deleteMany({ where: { id: { in: scopes.map((scope) => scope.cloudWorkspaceId) } } }));
      await firstPrisma!.$disconnect(); await secondPrisma!.$disconnect();
    });
    const scoped = <T>(work: () => T, index = 0) => runInCloudWorkspace(scopes[index], work);
    const create = (summary: RangeResourceSummary = { mode: 'opentofu', vpcId: 'vpc-preserve', hostIds: { host: 'ins-host', other: 'ins-other' }, eipAllocationIds: { egress: 'eip-preserve' } }) => scoped(() => repository.createRangeInstance({ name: 'DNS fixture', status: 'running', resourceSummary: summary }));

    it('writes one JSON key and preserves all other cloud and host state', async () => {
      const other = entry('ins-other', 'other-claim');
      const instance = await create({ mode: 'opentofu', hostIds: { host: 'ins-host', other: 'ins-other' }, vpcId: 'vpc-preserve', eipAllocationIds: { egress: 'eip-preserve' }, dnsVerification: { other } });
      const update = entry();
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, update))).toBe(true);
      update.expected[0].servers.push('1.1.1.1');
      const state = (await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!;
      expect(state).toMatchObject({ vpcId: 'vpc-preserve', hostIds: { host: 'ins-host', other: 'ins-other' }, eipAllocationIds: { egress: 'eip-preserve' }, dnsVerification: { host: { claimId: 'claim-1', expected: [{ servers: ['10.0.0.1'] }] }, other } });
    });
    it('only grants one concurrent initial claim and rejects the losing claim completion', async () => {
      const instance = await create();
      const results = await scoped(() => Promise.all([
        repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry('ins-host', 'first')),
        second.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry('ins-host', 'second')),
      ]));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = (await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!.dnsVerification!.host.claimId;
      const loser = winner === 'first' ? 'second' : 'first';
      expect(await scoped(() => second.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', loser, entry('ins-host', loser, 'verified')))).toBe(false);
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', winner, entry('ins-host', winner, 'verified')))).toBe(true);
    });
    it('keeps simultaneous writes for different hosts without overwriting either', async () => {
      const instance = await create();
      expect(await scoped(() => Promise.all([
        repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()),
        second.updateRangeInstanceDnsState(instance.id, 'other', 'ins-other', null, entry('ins-other', 'other-claim')),
      ]))).toEqual([true, true]);
      expect((await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!.dnsVerification).toMatchObject({ host: { claimId: 'claim-1' }, other: { claimId: 'other-claim' } });
    });
    it('rejects stale state after destroy intake or native host replacement', async () => {
      const instance = await create();
      await scoped(() => repository.updateRangeInstance(instance.id, { status: 'pending_destroy' }));
      expect(await scoped(() => second.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).toBe(false);
      await scoped(() => repository.updateRangeInstance(instance.id, { status: 'running', resourceSummary: { mode: 'opentofu', hostIds: { host: 'ins-replacement' } } }));
      expect(await scoped(() => second.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).toBe(false);
      expect((await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!.hostIds).toEqual({ host: 'ins-replacement' });
    });
    it('cannot cross workspaces even with the same native IDs', async () => {
      const instance = await create();
      const foreign = await scoped(() => repository.createRangeInstance({ name: 'Foreign DNS fixture', status: 'running', resourceSummary: { mode: 'opentofu', hostIds: { host: 'ins-host' } } }), 1);
      expect(await scoped(() => second.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()), 1)).toBe(false);
      expect(await scoped(() => second.updateRangeInstanceDnsState(foreign.id, 'host', 'ins-host', null, entry()))).toBe(false);
      expect(await scoped(() => second.updateRangeInstanceDnsState(foreign.id, 'host', 'ins-host', null, entry()), 1)).toBe(true);
      expect((await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary).not.toHaveProperty('dnsVerification');
    });
    it('fails closed without a writable workspace and rejects mismatched report identity', async () => {
      const instance = await create();
      await expect(repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry())).rejects.toThrow('scope');
      await expect(runInSystemCloudWorkspaceScope(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).rejects.toThrow('scope');
      await expect(runInCloudWorkspace({ ...scopes[0], isReadOnly: true }, () => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).rejects.toThrow('read-only');
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry('ins-foreign')))).toBe(false);
    });
    it('requires complete absence for a null expected claim instead of replacing malformed proof', async () => {
      const instance = await create({ mode: 'opentofu', hostIds: { host: 'ins-host' }, dnsVerification: { host: { ...entry(), claimId: undefined } } } as any);
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).toBe(false);
      await scoped(() => repository.updateRangeInstance(instance.id, { resourceSummary: { mode: 'opentofu', hostIds: { host: 'ins-host' }, dnsVerification: null } as any }));
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, 'host', 'ins-host', null, entry()))).toBe(false);
    });
    it('does not mistake an inherited prototype for a native host identity', async () => {
      const instance = await create({ mode: 'opentofu', hostIds: {} });
      expect(await scoped(() => repository.updateRangeInstanceDnsState(instance.id, '__proto__', 'ins-host', null, entry()))).toBe(false);
    });
    it('treats quoted host keys as JSON data rather than SQL', async () => {
      for (const hostKey of ["host.with'quote"]) {
        const instance = await create({ mode: 'opentofu', hostIds: { [hostKey]: 'ins-host' } });
        expect((await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!.hostIds).toEqual({ [hostKey]: 'ins-host' });
        expect({ hostKey, accepted: await scoped(() => repository.updateRangeInstanceDnsState(instance.id, hostKey, 'ins-host', null, entry())) }).toEqual({ hostKey, accepted: true });
        const summary = (await scoped(() => repository.getRangeInstanceById(instance.id)))!.resourceSummary!;
        expect(Object.prototype.hasOwnProperty.call(summary.dnsVerification, hostKey)).toBe(true);
        expect(summary.dnsVerification![hostKey].claimId).toBe('claim-1');
      }
    });
  });
}
