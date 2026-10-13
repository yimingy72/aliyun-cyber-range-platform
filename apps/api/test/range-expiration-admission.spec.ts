import { RangeInstancesService } from '../src/admin/range-instances.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { compileTemplateTopology } from '@aliyun-cyber-range/scenario-runtime/compiled';

describe('range cloud deadline admission', () => {
  it('rejects an excessive Alibaba expiry before allocating a CIDR or queuing any cloud work', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({ name: 'expiry fixture', slug: 'expiry-fixture', version: 'v1', cloudProvider: 'alibaba_cloud', modulePathOrRef: 'fixture',
      topologySpec: { vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'main', name: 'main', purpose: 'entry', cidr: '10.0.1.0/24' }],
        hosts: [{ key: 'entry', name: 'entry', zoneKey: 'main', role: 'entry', privateIp: '10.0.1.10' }], publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] } } });
    const consume = jest.fn(), allocate = jest.fn(), dispatch = jest.fn();
    const service = new RangeInstancesService(repository, { resolveTemplateConsumptionVersion: consume } as any, {} as any,
      { allocateRangeCidr: allocate, allocate: allocate } as any, { dispatch } as any);
    await expect(service.launch({ templateId: template.id, name: 'invalid duration', expiresAt: new Date(Date.now() + 1100 * 24 * 60 * 60_000).toISOString() } as any,
      { id: 'admin', role: 'admin' } as any)).rejects.toThrow('1095');
    expect(consume).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect(await repository.listProvisionJobs()).toEqual([]);
  });
  it('rejects a new host in a legacy excessive-duration range without queuing an update or altering its original host', async () => {
    const repository = createMemoryAdminRepository();
    const metadata = { name: 'expiry fixture', slug: 'expiry-fixture', version: 'v1', cloudProvider: 'alibaba_cloud' as const, iacType: 'opentofu' as const,
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range' };
    const host = { id: 'old', kind: 'ecs', label: 'old host', zoneKey: 'main', role: 'entry', privateIp: '10.0.1.10', exposePublic: true, image: 'm-fixture', imageId: 'm-fixture',
      platformImageAssetId: 'asset-fixture', imageStrategy: { mode: 'fixed', imageId: 'm-fixture' }, nics: [{ id: 'nic-old', switchId: 'switch', privateIp: '10.0.1.10', secondaryIps: [], securityGroupRules: [] }] };
    const graph: any = { schemaVersion: '2.0.0', nodes: [{ id: 'router', kind: 'router', label: 'router', routeRole: 'vpc', egressType: 'none', bindEip: false },
      { id: 'switch', kind: 'switch', label: 'switch', zoneKey: 'main', cidr: '10.0.1.0/24', purpose: 'entry', nat: { snatEnabled: false, dnatMappings: [] }, aclRules: [] }, host],
      edges: [{ id: 'rs', fromNodeId: 'router', toNodeId: 'switch', relationType: 'manual' }, { id: 'sh', fromNodeId: 'switch', toNodeId: 'old', relationType: 'manual' }] };
    const baseline = compileTemplateTopology(graph, metadata), nextGraph = structuredClone(graph);
    nextGraph.nodes.push({ ...structuredClone(host), id: 'new', label: 'new host', role: 'internal', privateIp: '10.0.1.20', exposePublic: false,
      nics: [{ ...host.nics[0], id: 'nic-new', privateIp: '10.0.1.20' }] });
    nextGraph.edges.push({ id: 'sn', fromNodeId: 'switch', toNodeId: 'new', relationType: 'manual' });
    const draft = compileTemplateTopology(nextGraph, metadata);
    const instance = await repository.createRangeInstance({ name: 'legacy range', status: 'running', instanceMode: 'range', cloudProvider: 'alibaba_cloud', ownerUserId: 'admin',
      expiresAt: new Date(Date.now() + 1100 * 24 * 60 * 60_000).toISOString(), templateModulePathSnapshot: metadata.modulePathOrRef,
      runtimeTopologyGraph: baseline.topologyGraph as any, runtimeCompiledProvisionSpec: baseline.compiledProvisionSpec });
    await repository.updateRangeInstance(instance.id, { draftRevision: 1, draftTopologyGraph: draft.topologyGraph as any, draftTopologySpec: draft.topologySpec,
      draftScenarioTemplateSpec: draft.scenarioTemplateSpec, draftCompiledProvisionSpec: draft.compiledProvisionSpec });
    jest.spyOn(repository, 'getPlatformImageAssetById').mockResolvedValue({ id: 'asset-fixture', imageId: 'm-fixture', enabled: true, visibility: 'platform' } as never);
    const dispatch = jest.fn();
    const service = new RangeInstancesService(repository, new RangeTemplatesService(repository), {} as any, {} as any, { dispatch } as any);
    jest.spyOn(service as any, 'resolveDraftCompilationMetadata').mockResolvedValue(metadata);
    await expect(service.applyDraft(instance.id, { expectedDraftRevision: 1, previewToken: 'unused' } as any, { id: 'admin', role: 'admin' } as any)).rejects.toThrow('1095');
    expect(dispatch).not.toHaveBeenCalled(); expect(await repository.listProvisionJobs()).toEqual([]);
    expect((await repository.getRangeInstanceById(instance.id))?.runtimeTopologyGraph).toEqual(baseline.topologyGraph);
  });
});
