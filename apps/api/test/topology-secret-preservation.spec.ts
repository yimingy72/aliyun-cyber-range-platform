import { compileTemplateTopology, type ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { preserveOmittedHostPasswords } from '../src/admin/topology-secret-preservation';
import { validateRangeInstanceDraftPayload } from '../src/admin/range-instance-draft.validation';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { completeTemplatePayload } from './support/complete-template-payload';

const metadata = { name: 'Template 1', slug: 'template-1', version: 'v1', cloudProvider: 'alibaba_cloud' as const, iacType: 'opentofu' as const, modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range', primaryVpcCidr: '10.0.0.0/16', secondaryVpcCidrs: [], publicEntryProtocols: [{ protocol: 'ssh', port: 22 }] };
const base = completeTemplatePayload({ vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'zone', name: 'Zone', purpose: 'business', cidr: '10.0.0.0/24' }], hosts: [{ key: 'host', name: 'Host', zoneKey: 'zone', role: 'entry', privateIp: '10.0.0.10', exposePublic: true }], publicEntry: { hostKey: 'host', protocols: metadata.publicEntryProtocols } });
const source = { ...base.topologyGraph, nodes: (base.topologyGraph.nodes as any[]).map(node => node.kind === 'ecs' ? { ...node, customPassword: 'OpaqueExisting1!' } : node) };
function inputFor(graph = base.topologyGraph) {
  const compiled = JSON.parse(JSON.stringify(compileTemplateTopology(graph as ScenarioGraphDraft, metadata)));
  return { draftTopologyGraph: compiled.topologyGraph, draftTopologySpec: compiled.topologySpec, draftScenarioTemplateSpec: compiled.scenarioTemplateSpec, draftCompiledProvisionSpec: compiled.compiledProvisionSpec };
}

describe('opaque topology secret updates', () => {
  it('preserves only matching omitted host secrets without mutating the input or copying credentials to new hosts', () => {
    const requested = { nodes: [{ id: 'host', kind: 'ecs' }, { id: 'new-host', kind: 'ecs' }, { id: 'not-host', kind: 'switch' }] };
    const result = preserveOmittedHostPasswords(source, requested);
    expect(result.nodes).toEqual([{ id: 'host', kind: 'ecs', customPassword: 'OpaqueExisting1!' }, { id: 'new-host', kind: 'ecs' }, { id: 'not-host', kind: 'switch' }]);
    expect(requested.nodes[0]).not.toHaveProperty('customPassword');
    expect(preserveOmittedHostPasswords(source, { nodes: [{ id: 'host', kind: 'ecs', customPassword: 'ExplicitNew2!' }] }).nodes).toEqual([{ id: 'host', kind: 'ecs', customPassword: 'ExplicitNew2!' }]);
  });

  it('restores and recompiles saved runtime passwords after validating caller snapshots', () => {
    const restored = validateRangeInstanceDraftPayload(inputFor(), metadata, source);
    expect((restored.topologyGraph.nodes as any[]).find(node => node.id === 'host').customPassword).toBe('OpaqueExisting1!');
    expect(JSON.stringify(restored.scenarioTemplateSpec)).toContain('OpaqueExisting1!');
    const forged = inputFor(); forged.draftCompiledProvisionSpec.identity.templateSlug = 'forged';
    expect(() => validateRangeInstanceDraftPayload(forged, metadata, source)).toThrow('does not match');
  });

  it('preserves template passwords entirely inside the service after a redacted whole-graph edit', async () => {
    const service = new RangeTemplatesService({} as any);
    jest.spyOn(service, 'assertTemplateEcsImageSelections').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'validateTopologyPayload').mockResolvedValue(undefined);
    const edited = { ...base.topologyGraph, nodes: (base.topologyGraph.nodes as any[]).map(node => node.kind === 'ecs' ? { ...node, label: 'Edited label' } : node) };
    const payload = JSON.parse(JSON.stringify(compileTemplateTopology(edited as ScenarioGraphDraft, metadata)));
    const restored = await (service as any).normalizeAndValidateTopology({ ...metadata, topologyGraph: source }, payload, { id: 'owner', role: 'user' });
    expect(restored.topologyGraph.nodes.find((node: any) => node.id === 'host')).toMatchObject({ label: 'Edited label', customPassword: 'OpaqueExisting1!' });
    expect(JSON.stringify(restored.scenarioTemplateSpec)).toContain('OpaqueExisting1!');
    const forged = { ...payload, compiledProvisionSpec: { ...payload.compiledProvisionSpec, topology: { ...payload.compiledProvisionSpec.topology, entryHostKey: 'foreign' } } };
    await expect((service as any).normalizeAndValidateTopology({ ...metadata, topologyGraph: source }, forged, { id: 'owner', role: 'user' })).rejects.toThrow('does not match');
  });
});
