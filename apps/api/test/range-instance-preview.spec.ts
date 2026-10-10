import { compileTemplateTopology, type ScenarioGraphDraft, type TemplateAuthoringMetadata } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

import { buildRangeChangeApproval, rangeDraftSourceDigest, rangeRuntimeIdentityDigest } from '../src/admin/range-draft-change-policy';
const actor = { id: 'owner', role: 'user' as const };
const scope = { cloudWorkspaceId: 'template-copy-workspace', provider: 'alibaba_cloud' as const, accountUid: '1001', cloudAccountContextId: 'context-a' };
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
  const instance = await repository.createRangeInstance({ name: 'Running', expiresAt: '2099-01-01T00:00:00Z', status: 'running', instanceMode: 'range', ownerUserId: actor.id, templateId: source.id, sourceTemplateVersionId: source.currentDraftVersionId, templateSlugSnapshot: 'original', templateVersionSnapshot: 'v1', templateModulePathSnapshot: metadata.modulePathOrRef, runtimeTopologyGraph: compiled.topologyGraph, runtimeScenarioTemplateSpec: compiled.scenarioTemplateSpec, runtimeCompiledProvisionSpec: compiled.compiledProvisionSpec, runtimeCredentials: { entry: { username: 'root', password: 'Runtime-Password!123' } }, resourceSummary: { mode: 'opentofu', vpcId: 'vpc-original', hostIds: { entry: 'i-original' }, executionContext: { provider, cloudAccountContextId: scope.cloudAccountContextId, cloudAccountUid: scope.accountUid, regionId: metadata.defaultRegion!, zoneId: metadata.defaultZoneId! } }, draftTopologyGraph: compiled.topologyGraph, draftTopologySpec: compiled.topologySpec, draftScenarioTemplateSpec: compiled.scenarioTemplateSpec, draftCompiledProvisionSpec: compiled.compiledProvisionSpec, draftRevision: 1 });
  const worker = { dispatch: jest.fn() };
  const system = { getExecutionAccountContext: jest.fn().mockResolvedValue({ provider, defaultRegion: metadata.defaultRegion, defaultZoneId: metadata.defaultZoneId, accountUid: scope.accountUid, cloudAccountContextId: scope.cloudAccountContextId, accountUidResolved: true }) };
  const service = new RangeInstancesService(repository, new RangeTemplatesService(repository, system as any), system as any, {} as any, worker as any);
  return { repository, source, instance, service, worker, run, asset, system };
 });
}


const payload = { expectedDraftRevision: 1 };
describe('preview-bound runtime apply', () => {
 it('returns expected changes without credentials or claiming an actual OpenTofu plan, then freezes approval in one job', async () => {
  const f = await fixture(); await f.run(async () => {
   const preview = await f.service.previewDraft(f.instance.id, payload, actor);
   expect(preview).toMatchObject({ kind: 'expected-topology-diff', addedHosts: [], deletedHosts: [], ruleChanges: [] });
   expect(preview.previewToken).toBeTruthy(); expect(preview.sourceDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
   expect(JSON.stringify(preview)).not.toMatch(/Runtime-Password|Legacy-Password|TopLevel-Runtime|runtimeCredentials|initScript/);
   expect(f.worker.dispatch).not.toHaveBeenCalled(); expect(await f.repository.listProvisionJobs()).toHaveLength(0);
   const job = await f.service.applyDraft(f.instance.id, { ...payload, previewToken: preview.previewToken }, actor);
   expect(job.topologySnapshot?.changeApproval).toMatchObject({ version: 1, addedHostKeys: [], deletedHostKeys: [] });
   expect(f.worker.dispatch).toHaveBeenCalledTimes(1); expect(f.worker.dispatch).toHaveBeenCalledWith(job.id);
   await expect(f.service.applyDraft(f.instance.id, { ...payload, previewToken: preview.previewToken }, actor)).rejects.toThrow();
   expect(await f.repository.listProvisionJobs()).toHaveLength(1);
  });
 });
 it.each(['revision', 'host-id', 'expiry', 'last-job', 'account', 'actor', 'expired-token'] as const)('rejects stale %s authorization before enqueuing or touching resources', async cause => {
  const f = await fixture(); await f.run(async () => {
   const preview = await f.service.previewDraft(f.instance.id, payload, actor);
   if (cause === 'revision') await f.repository.updateRangeInstance(f.instance.id, { draftRevision: 2 });
   if (cause === 'host-id') await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { ...f.instance.resourceSummary!, hostIds: { entry: 'i-replacement' } } });
   if (cause === 'expiry') await f.repository.updateRangeInstance(f.instance.id, { expiresAt: new Date('2098-01-01') });
   if (cause === 'last-job') await f.repository.updateRangeInstance(f.instance.id, { lastJobId: 'other-job' });
   if (cause === 'account') await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { ...f.instance.resourceSummary!, executionContext: { ...f.instance.resourceSummary!.executionContext!, cloudAccountUid: 'different' } } });
   if (cause === 'expired-token') { const actual = f.repository.getOperationConfirmationById.bind(f.repository); jest.spyOn(f.repository, 'getOperationConfirmationById').mockImplementation(async id => { const current = await actual(id); return current ? { ...current, expiresAt: new Date(0) } : null; }); }
   await expect(f.service.applyDraft(f.instance.id, { ...payload, previewToken: preview.previewToken }, cause === 'actor' ? { id: 'admin', role: 'admin' } : actor)).rejects.toThrow();
   expect(await f.repository.listProvisionJobs()).toHaveLength(0); expect(f.worker.dispatch).not.toHaveBeenCalled();
  });
 });
 it('rejects a source mutation after service checks at the atomic enqueue boundary', async () => {
  const f = await fixture(); await f.run(async () => {
   const preview = await f.service.previewDraft(f.instance.id, payload, actor);
   const enqueue = f.repository.applyRangeInstanceDraft.bind(f.repository);
   jest.spyOn(f.repository, 'applyRangeInstanceDraft').mockImplementation(async input => { await f.repository.updateRangeInstance(f.instance.id, { expiresAt: new Date('2098-01-01') }); return enqueue(input); });
   await expect(f.service.applyDraft(f.instance.id, { ...payload, previewToken: preview.previewToken }, actor)).rejects.toThrow();
   expect(await f.repository.listProvisionJobs()).toHaveLength(0);
   expect((await f.repository.getOperationConfirmationById(preview.previewToken))!.consumedAt).toBeNull();
  });
 });
 it('allows old disabled images for a rule-only update and never recreates an old host to regain availability', async () => {
  const f = await fixture(); await f.run(async () => {
   await f.repository.setPlatformImageAssetEnabled(f.asset.id, false);
   const graph = structuredClone(f.instance.runtimeTopologyGraph!) as unknown as ScenarioGraphDraft;
   const switchNode = graph.nodes.find(node => node.kind === 'switch')! as any;
   switchNode.aclRules = [{ key: 'deny', direction: 'inbound', protocol: 'tcp', portRange: '445/445', sourceCidr: '0.0.0.0/0', policy: 'drop', priority: 10 }];
   const compiled = JSON.parse(JSON.stringify(compileTemplateTopology(graph, { name: 'Original', slug: 'original', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu', modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range', primaryVpcCidr: '10.0.0.0/16', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' })));
   const saved = await f.service.saveDraft(f.instance.id, { expectedDraftRevision: 1, draftTopologyGraph: compiled.topologyGraph, draftTopologySpec: compiled.topologySpec, draftScenarioTemplateSpec: compiled.scenarioTemplateSpec, draftCompiledProvisionSpec: compiled.compiledProvisionSpec }, actor);
   const preview = await f.service.previewDraft(f.instance.id, { expectedDraftRevision: saved.draftRevision! }, actor);
   expect(preview.ruleChanges).toEqual([{ nodeId: 'switch', name: 'Switch', nodeKind: 'switch' }]);
   await expect(f.service.applyDraft(f.instance.id, { expectedDraftRevision: saved.draftRevision!, previewToken: preview.previewToken }, actor)).resolves.toMatchObject({ jobType: 'update' });
  });
 });
});

describe('runtime immutable identity policy', () => {
 it.each(['imageId', 'cpu', 'privateIp', 'initScript', 'customPassword', 'dns', 'nic-ip', 'nic-order', 'cidr'] as const)('blocks changing deployed %s', async field => {
  const f = await fixture(); const graph = structuredClone(f.instance.runtimeTopologyGraph!) as any; const host = graph.nodes.find((node: any) => node.kind === 'ecs');
  if (field === 'nic-ip') host.nics[0].privateIp = '10.0.1.12';
  else if (field === 'nic-order') host.nics.unshift({ ...host.nics[0], id: 'other-nic', privateIp: '10.0.1.11' });
  else if (field === 'cidr') graph.nodes.find((node: any) => node.kind === 'switch').cidr = '10.0.2.0/24';
  else host[field] = field === 'cpu' ? 8 : field === 'dns' ? { servers: ['10.0.1.2'], nicIds: ['nic'] } : 'different';
  expect(() => buildRangeChangeApproval(f.instance, { draftRevision: 1, topologyGraph: graph, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: 'fixture' })).toThrow();
 });
 it('keeps runtime identity stable across claim bookkeeping and read-only DNS verification', async () => {
  const f = await fixture(); const original = rangeRuntimeIdentityDigest(f.instance);
  expect(rangeRuntimeIdentityDigest({ ...f.instance, lastJobId: 'new-update-job', status: 'running', draftRevision: 100, resourceSummary: { ...f.instance.resourceSummary!, dnsVerification: {} } })).toBe(original);
  expect(rangeDraftSourceDigest(f.instance, actor.id, scope.cloudWorkspaceId)).not.toBe(rangeDraftSourceDigest({ ...f.instance, lastJobId: 'changed' }, actor.id, scope.cloudWorkspaceId));
 });
 it('describes explicit added/deleted hosts and removal of DNAT/SNAT as expected candidates', async () => {
  const f = await fixture(); const graph = structuredClone(f.instance.runtimeTopologyGraph!) as any;
  const host = graph.nodes.find((node: any) => node.kind === 'ecs'); host.id = 'new-host'; host.nics = [{ ...host.nics[0], id: 'new-nic', privateIp: '10.0.1.20' }]; host.privateIp = '10.0.1.20';
  const original = { ...f.instance, expiresAt: new Date('2099-01-01'), runtimeCompiledProvisionSpec: { dnatEntries: [{ key: 'entry-dnat' }], snatEntries: [{ key: 'entry-snat' }] } };
  const snapshot = { draftRevision: 1, topologyGraph: graph, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: { dnatEntries: [], snatEntries: [] }, compiledSpec: {}, templateModulePath: 'fixture' };
  expect(buildRangeChangeApproval(original, snapshot)).toMatchObject({ addedHostKeys: ['new-host'], deletedHostKeys: ['entry'], allowDnatRemoval: true, allowSnatRemoval: true });
  expect(() => buildRangeChangeApproval({ ...original, expiresAt: new Date(0) }, snapshot)).toThrow('到期');
 });
});


describe('expected topology inventory preview', () => {
 it('includes added switches with their subnet instead of hiding network creation', async () => {
  const { expectedRangeChangeSummary } = await import('../src/admin/range-draft-change-policy');
  const f = await fixture();
  const newSwitch = { id: 'switch-new', kind: 'switch', label: '新增交换机', zoneKey: 'network-new', cidr: '10.0.20.0/24' };
  const graph = { ...f.instance.runtimeTopologyGraph, nodes: [...(f.instance.runtimeTopologyGraph!.nodes as any[]), newSwitch] };
  const preview = expectedRangeChangeSummary(f.instance, { topologyGraph: graph, draftRevision: 2 } as any, {
   version: 1, addedHostKeys: [], deletedHostKeys: [], runtimeIdentityDigest: 'runtime', topologyDigest: 'draft', allowDnatRemoval: false, allowSnatRemoval: false,
  });
  expect(preview.addedNetworks).toEqual([{ nodeId: 'switch-new', name: '新增交换机', zoneKey: 'network-new', cidr: '10.0.20.0/24' }]);
 });
});
