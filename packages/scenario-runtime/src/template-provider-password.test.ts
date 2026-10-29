import { describe, expect, it } from 'vitest';
import { compileTemplateTopology } from './template-topology-compiler';
import type { ScenarioGraphDraft } from './scenario-graph';

const graph: ScenarioGraphDraft = {
  schemaVersion: '2.0.0',
  nodes: [
    { id: 'router', kind: 'router', label: 'VPC', routeRole: 'vpc', egressType: 'none', bindEip: false },
    { id: 'subnet', kind: 'switch', label: 'Subnet', zoneKey: 'core', cidr: '10.0.0.0/24', purpose: 'business-zone',
      nat: { snatEnabled: false, dnatMappings: [] }, aclRules: [] },
    { id: 'host', kind: 'ecs', label: 'Host', zoneKey: 'core', role: 'host', privateIp: '10.0.0.10', exposePublic: false,
      image: 'img-fixture', imageId: 'img-fixture', platformImageAssetId: 'asset', dnatMappings: [], networkInterfaces: [], portGroups: [],
      initScript: '', imageStrategy: { mode: 'fixed', imageId: 'img-fixture' }, instanceTypeStrategy: { mode: 'auto' },
      nics: [{ id: 'nic', switchId: 'subnet', privateIp: '10.0.0.10', secondaryIps: [], securityGroupRules: [] }] },
  ],
  edges: [
    { id: 'router-subnet', fromNodeId: 'router', toNodeId: 'subnet', relationType: 'manual' },
    { id: 'subnet-host', fromNodeId: 'subnet', toNodeId: 'host', relationType: 'manual' },
  ],
};

function compile(provider: 'alibaba_cloud' | 'tencent_cloud', password: string, windows = false) {
  const input = structuredClone(graph);
  const host = input.nodes.find(node => node.kind === 'ecs')!;
  if (host.kind !== 'ecs') throw new Error('missing fixture host');
  host.customPassword = password;
  return compileTemplateTopology(input, { name: 'Fixture', slug: 'fixture', version: 'v1', cloudProvider: provider,
    iacType: 'opentofu', modulePathOrRef: 'fixture', secondaryVpcCidrs: [] }, { asset: { osType: windows ? 'windows' : 'linux' } });
}

describe('shared template compiler uses the selected provider and resolved image OS', () => {
  it('accepts Tencent Linux two-class passwords but keeps Alibaba requirements unchanged', () => {
    expect(() => compile('tencent_cloud', 'abcdefgh1')).not.toThrow();
    expect(() => compile('alibaba_cloud', 'abcdefgh1')).toThrow('at least three');
  });
  it('rejects short Tencent Windows passwords at authoring, not after provisioning', () => {
    expect(() => compile('tencent_cloud', 'Abcd1234', true)).toThrow('12-30');
    expect(() => compile('tencent_cloud', 'Abcdefgh1234', true)).not.toThrow();
    expect(() => compile('alibaba_cloud', 'Abcd1234', true)).not.toThrow();
  });
  it.each(['_', '<', '>'])('rejects Tencent creation-unsupported %s without changing Alibaba templates', symbol => {
    expect(() => compile('tencent_cloud', `Abcdefgh1234${symbol}`)).toThrow('Tencent CVM LoginSettings');
    expect(() => compile('alibaba_cloud', `Abcdefgh1234${symbol}`)).not.toThrow();
  });
  it('retains the distinct Linux slash policy after switching between providers', () => {
    expect(() => compile('alibaba_cloud', '/Abcd1234')).not.toThrow();
    expect(() => compile('tencent_cloud', '/Abcd1234')).toThrow('forward slash');
    expect(() => compile('alibaba_cloud', '/Abcd1234')).not.toThrow();
  });
});
