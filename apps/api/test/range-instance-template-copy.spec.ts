import { compileTemplateTopology, type ScenarioGraphDraft, type TemplateAuthoringMetadata } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const actor = { id: 'owner', role: 'user' as const };
const scope = { cloudWorkspaceId: 'template-copy-workspace', provider: 'alibaba_cloud' as const, accountUid: '1001', cloudAccountContextId: 'context-a' };
const scoped = <T>(work: () => T) => runInCloudWorkspace(scope, work);
async function fixture(provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud') {
 const repository = createMemoryAdminRepository();
 const actualScope = { ...scope, provider };
 const run = <T>(work: () => T) => runInCloudWorkspace(actualScope, work);
 const metadata: TemplateAuthoringMetadata = { name: 'Original', slug: 'original', version: 'v1', cloudProvider: provider, iacType: 'opentofu', modulePathOrRef: `infra/opentofu/modules/${provider === 'alibaba_cloud' ? 'alicloud' : 'tencentcloud'}-enterprise-range`, primaryVpcCidr: '10.0.0.0/16', defaultRegion: provider === 'alibaba_cloud' ? 'cn-hangzhou' : 'ap-nanjing', defaultZoneId: provider === 'alibaba_cloud' ? 'cn-hangzhou-h' : 'ap-nanjing-1' };
 return run(async () => {
  await repository.upsertImageSnapshots({ provider, accountUid: scope.accountUid, regionId: metadata.defaultRegion!, scope: 'public', snapshots: [{ imageId: 'img-entry', sourceImageName: 'Image', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
  const [snapshot] = await repository.listImageSnapshots({ imageId: 'img-entry' });
  const asset = await repository.collectPlatformImageAsset({ snapshotId: snapshot.id, displayName: 'Image', ownerUserId: actor.id, visibility: 'private' });
  const graph: ScenarioGraphDraft = { schemaVersion: '2.0.0', nodes: [
   { id: 'router', kind: 'router', label: 'Router', routeRole: 'vpc', egressType: 'none', bindEip: false },
   { id: 'switch', kind: 'switch', label: 'Switch', zoneKey: 'dmz', cidr: '10.0.1.0/24', purpose: 'public-entry', aclRules: [], nat: { snatEnabled: provider === 'tencent_cloud', dnatMappings: [{ key: 'ssh', targetHostId: 'entry', externalPort: 22, internalPort: 22, protocol: 'tcp' }] } },
   { id: 'entry', kind: 'ecs', label: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.10', exposePublic: true, image: 'Image', imageId: 'img-entry', platformImageAssetId: asset.id, imageStrategy: { mode: 'fixed', imageId: 'img-entry' }, instanceTypeStrategy: { mode: 'auto' }, nics: [{ id: 'nic', switchId: 'switch', privateIp: '10.0.1.10', secondaryIps: [], securityGroupRules: [] }], networkInterfaces: [], dnatMappings: [], portGroups: [], initScript: '', customPassword: 'Legacy-Password!123' },
  ], edges: [{ id: 'a', fromNodeId: 'router', toNodeId: 'switch', relationType: 'manual' }, { id: 'b', fromNodeId: 'switch', toNodeId: 'entry', relationType: 'manual' }] };
  (graph as any).runtimeCredentials = { password: 'TopLevel-Runtime!123' }; (graph.nodes[2] as any).cloudInstanceId = 'i-annotated'; (graph.nodes[2] as any).nics[0].networkInterfaceId = 'eni-annotated';
  const compiled = JSON.parse(JSON.stringify(compileTemplateTopology(graph, metadata)));
  const source = await repository.createRangeTemplate({ ...compiled, name: 'Original', slug: 'original', version: 'v1', modulePathOrRef: metadata.modulePathOrRef, cloudProvider: provider, createdBy: 'author', ownerUserId: 'author', visibility: 'platform' });
  const instance = await repository.createRangeInstance({ name: 'Running', status: 'running', instanceMode: 'range', ownerUserId: actor.id, templateId: source.id, sourceTemplateVersionId: source.currentDraftVersionId, templateSlugSnapshot: 'original', templateVersionSnapshot: 'v1', templateModulePathSnapshot: metadata.modulePathOrRef, runtimeTopologyGraph: compiled.topologyGraph, runtimeScenarioTemplateSpec: compiled.scenarioTemplateSpec, runtimeCompiledProvisionSpec: compiled.compiledProvisionSpec, runtimeCredentials: { entry: { username: 'root', password: 'Runtime-Password!123' } }, resourceSummary: { mode: 'opentofu', vpcId: 'vpc-original', hostIds: { entry: 'i-original' }, executionContext: { provider, cloudAccountContextId: scope.cloudAccountContextId, cloudAccountUid: scope.accountUid, regionId: metadata.defaultRegion!, zoneId: metadata.defaultZoneId! } }, draftTopologyGraph: compiled.topologyGraph, draftTopologySpec: compiled.topologySpec, draftScenarioTemplateSpec: compiled.scenarioTemplateSpec, draftCompiledProvisionSpec: compiled.compiledProvisionSpec, draftRevision: 1 });
  const worker = { dispatch: jest.fn() };
  const system = { getExecutionAccountContext: jest.fn().mockResolvedValue({ provider, defaultRegion: metadata.defaultRegion, defaultZoneId: metadata.defaultZoneId, accountUid: scope.accountUid, cloudAccountContextId: scope.cloudAccountContextId, accountUidResolved: true }) };
  const service = new RangeInstancesService(repository, new RangeTemplatesService(repository, system as any), system as any, {} as any, worker as any);
  return { repository, source, instance, service, worker, run, asset, system };
 });
}

describe('save runtime draft as new private template', () => {
 it.each(['alibaba_cloud', 'tencent_cloud'] as const)('preserves original %s template/version/instance and strips runtime credentials', async provider => {
  const f = await fixture(provider);
  await f.run(async () => {
   const before = await f.repository.getRangeInstanceById(f.instance.id);
   const original = await f.repository.getRangeTemplateById(f.source.id);
   const result = await f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: 1 }, actor, 'copy-1');
   const copy = await f.repository.getRangeTemplateById(result.templateId as string);
   expect(copy).toMatchObject({ name: 'Copy', ownerUserId: actor.id, createdBy: actor.id, visibility: 'private', revision: 1, currentPublishedVersionId: null, cloudProvider: provider });
   expect(copy!.id).not.toBe(f.source.id); expect(copy!.slug).not.toBe(f.source.slug);
   expect(copy!.versions).toHaveLength(1); expect(copy!.currentDraftVersion).toMatchObject({ status: 'draft' });
   expect(copy!.scenarioTemplateSpec).toMatchObject({ metadata: { name: 'Copy', slug: copy!.slug }, topology: { defaultRegion: provider === 'alibaba_cloud' ? 'cn-hangzhou' : 'ap-nanjing' } });
   for (const forbidden of ['Runtime-Password', 'Legacy-Password', 'vpc-original', 'i-original', 'runtimeCredentials', 'workspaceDir', 'customPassword', 'TopLevel-Runtime', 'i-annotated', 'eni-annotated']) expect(JSON.stringify(copy)).not.toContain(forbidden);
   expect(await f.repository.getRangeTemplateById(f.source.id)).toEqual(original);
   expect(await f.repository.getRangeInstanceById(f.instance.id)).toEqual(before);
   expect(f.worker.dispatch).not.toHaveBeenCalled(); expect(f.system.getExecutionAccountContext).toHaveBeenCalledWith();
  });
 });
 it('accepts the normal request workspace scope without an execution context field', async () => {
  const f = await fixture();
  const { cloudAccountContextId: _context, ...requestScope } = scope;
  await expect(runInCloudWorkspace(requestScope, () => f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: 1 }, actor, 'normal-scope'))).resolves.toMatchObject({ visibility: 'private' });
 });
 it('replays an uncertain response with the same key and rejects changed arguments', async () => {
  const f = await fixture(); await f.run(async () => {
   const payload = { name: 'Copy', expectedDraftRevision: 1 };
   const first = await f.service.saveAsNewTemplate(f.instance.id, payload, actor, 'stable');
   await f.repository.updateRangeInstance(f.instance.id, { draftRevision: 2, draftTopologyGraph: null });
   expect(await f.service.saveAsNewTemplate(f.instance.id, payload, actor, 'stable')).toEqual(first);
   expect(await f.repository.listRangeTemplates()).toHaveLength(2);
   await expect(f.service.saveAsNewTemplate(f.instance.id, { ...payload, name: 'Different' }, actor, 'stable')).rejects.toThrow('another request');
  });
 });
 it.each(['other-owner', 'stale', 'missing', 'wrong-account', 'disabled-image'] as const)('rejects %s without creating a template or job', async cause => {
  const f = await fixture(); await f.run(async () => {
   if (cause === 'missing') await f.repository.updateRangeInstance(f.instance.id, { draftTopologyGraph: null });
   if (cause === 'wrong-account') await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', executionContext: { provider: 'alibaba_cloud', cloudAccountContextId: 'different', cloudAccountUid: '1001', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' } } });
   if (cause === 'disabled-image') await f.repository.setPlatformImageAssetEnabled(f.asset.id, false);
   await expect(f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: cause === 'stale' ? 2 : 1 }, cause === 'other-owner' ? { id: 'other', role: 'user' } : actor, 'rejected')).rejects.toThrow();
   expect(await f.repository.listRangeTemplates()).toHaveLength(1); expect(await f.repository.listProvisionJobs()).toHaveLength(0);
  });
 });
 it('rejects a changed default region for the same UID instead of exporting unusable images', async () => {
  const f = await fixture(); await f.run(async () => {
   f.system.getExecutionAccountContext.mockResolvedValue({ provider: 'alibaba_cloud', accountUid: scope.accountUid, accountUidResolved: true, cloudAccountContextId: 'beijing-context', defaultRegion: 'cn-beijing', defaultZoneId: 'cn-beijing-h' });
   await expect(f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: 1 }, actor, 'region-change')).rejects.toThrow('地域');
   expect(await f.repository.listRangeTemplates()).toHaveLength(1);
  });
 });
 it('atomically rejects source revision change after compilation', async () => {
  const f = await fixture(); await f.run(async () => {
   const create = f.repository.createRangeTemplateFromInstance.bind(f.repository);
   jest.spyOn(f.repository, 'createRangeTemplateFromInstance').mockImplementation(async input => { await f.repository.updateRangeInstance(f.instance.id, { draftRevision: 2 }); return create(input); });
   await expect(f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: 1 }, actor, 'race')).rejects.toThrow('changed');
   expect(await f.repository.listRangeTemplates()).toHaveLength(1);
  });
 });
 it('keeps workspace isolation even for administrators', async () => {
  const f = await fixture();
  await expect(runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'other-workspace' }, () => f.service.saveAsNewTemplate(f.instance.id, { name: 'Copy', expectedDraftRevision: 1 }, { id: 'admin', role: 'admin' }, 'key'))).rejects.toThrow('not found');
 });
});
