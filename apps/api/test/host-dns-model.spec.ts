import { compileTemplateTopology, validateHostDnsConfig, type ScenarioGraphDraft, type TemplateAuthoringMetadata } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { buildEnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';

const metadata: TemplateAuthoringMetadata = { name: 'DNS test', slug: 'dns-test', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu', modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range' };
const dns = { servers: ['10.0.1.10', '10.0.1.11'], nicIds: ['nic-secondary'], domain: 'ad.test' };
function graph(): ScenarioGraphDraft {
  return { schemaVersion: '2.0.0', nodes: [
    { id: 'router', kind: 'router', label: 'Router', routeRole: 'egress', egressType: 'internet', bindEip: false },
    { id: 'switch', kind: 'switch', label: 'DMZ', zoneKey: 'dmz', cidr: '10.0.1.0/24', purpose: 'dmz', aclRules: [], nat: { snatEnabled: true, dnatMappings: [{ key: 'http', targetHostId: 'host', externalPort: 80, internalPort: 80, protocol: 'tcp' }] } },
    { id: 'switch-secondary', kind: 'switch', label: 'Internal', zoneKey: 'internal', cidr: '10.0.2.0/24', purpose: 'internal', aclRules: [], nat: { snatEnabled: false, dnatMappings: [] } },
    { id: 'host', kind: 'ecs', label: 'Windows', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.20', image: 'Windows', imageId: 'test-image', exposePublic: true, initScript: '', dnatMappings: [], networkInterfaces: [], portGroups: [], imageStrategy: { mode: 'fixed', imageId: 'test-image' }, instanceTypeStrategy: { mode: 'auto' }, nics: [
      { id: 'nic-primary', switchId: 'switch', privateIp: '10.0.1.20', secondaryIps: [], securityGroupRules: [] },
      { id: 'nic-secondary', switchId: 'switch-secondary', privateIp: '10.0.2.20', secondaryIps: ['10.0.2.21'], securityGroupRules: [] },
    ], dns },
  ], edges: [
    { id: 'r-s', fromNodeId: 'router', toNodeId: 'switch', relationType: 'manual' },
    { id: 'r-s2', fromNodeId: 'router', toNodeId: 'switch-secondary', relationType: 'manual' },
    { id: 's-h', fromNodeId: 'switch', toNodeId: 'host', relationType: 'manual' },
    { id: 's2-h', fromNodeId: 'switch-secondary', toNodeId: 'host', relationType: 'manual' },
  ] };
}
function plan(payload: any) {
  return buildEnterpriseProvisionPlan({ rangeInstanceId: 'dns-test', templateModulePath: metadata.modulePathOrRef, ...payload, allocatedCidr: null });
}

describe('per-host DNS model boundaries', () => {
  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('preserves selected NIC identity and DNS through %s compilation and provisioning', (cloudProvider) => {
    const payload: any = compileTemplateTopology(graph(), { ...metadata, cloudProvider });
    expect(payload.topologyGraph.nodes.find((node: any) => node.id === 'host').dns).toEqual(dns);
    expect(payload.topologySpec.hosts[0].dns).toEqual(dns);
    expect(payload.scenarioTemplateSpec.hosts[0].dns).toEqual(dns);
    expect(payload.compiledProvisionSpec.hosts[0].dns).toEqual(dns);
    expect(payload.compiledSpec.resources.find((resource: any) => resource.id === 'host').config.dns).toEqual(dns);
    const result = plan(payload);
    expect(result.hostDefinitions[0].dns).toEqual(dns);
    expect(result.hostNetworkInterfaces[0].interfaces[1]).toMatchObject({ nicId: 'nic-secondary', deviceIndex: 1, zoneKey: 'internal', privateIp: '10.0.2.20', secondaryIps: ['10.0.2.21'] });
  });
  it('retains DNS and NIC placement when only a compiled resource snapshot is available', () => {
    const payload: any = compileTemplateTopology(graph(), metadata);
    const result = plan({ compiledSpec: payload.compiledSpec });
    expect(result.hostDefinitions[0].dns).toEqual(dns);
    expect(result.hostNetworkInterfaces[0].interfaces[1]).toMatchObject({ nicId: 'nic-secondary', deviceIndex: 1, zoneKey: 'internal', privateIp: '10.0.2.20', secondaryIps: ['10.0.2.21'] });
  });
  it('leaves legacy graphs without a DNS override unchanged', () => {
    const value = graph(); delete (value.nodes[3] as any).dns;
    const payload: any = compileTemplateTopology(value, metadata);
    expect(payload.scenarioTemplateSpec.hosts[0]).not.toHaveProperty('dns');
    expect(payload.compiledProvisionSpec.hosts[0]).not.toHaveProperty('dns');
    expect(plan(payload).hostDefinitions[0]).not.toHaveProperty('dns');
  });
  it.each([
    null, {}, { ...dns, servers: [] }, { ...dns, servers: ['10.0.0.1', '10.0.0.1'] },
    { ...dns, servers: ['0.0.0.0'] }, { ...dns, servers: ['0.1.2.3'] }, { ...dns, servers: ['224.0.0.1'] }, { ...dns, servers: ['255.255.255.255'] },
    { ...dns, servers: ['10.0.0.999'] }, { ...dns, servers: ['10.00.0.1'] }, { ...dns, servers: ['10.0.0.1;Stop-Computer'] },
    { ...dns, servers: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'] },
    { ...dns, nicIds: [] }, { ...dns, nicIds: ['foreign-nic'] }, { ...dns, nicIds: ['nic-secondary', 'nic-secondary'] },
    { ...dns, domain: 'ad.test;shutdown' }, { ...dns, domain: '_ad.test' }, { ...dns, domain: '域.test' }, { ...dns, domain: '' },
    { ...dns, typo: true },
  ])('rejects invalid or executable DNS input before saving', (invalid) => {
    const value = graph(); (value.nodes[3] as any).dns = invalid;
    expect(() => compileTemplateTopology(value, metadata)).toThrow(/dns/);
  });
  it('rejects DNS when its selected NIC is absent from the provisioning snapshot', () => {
    const payload: any = compileTemplateTopology(graph(), metadata);
    payload.compiledProvisionSpec.hosts[0].dns = { ...dns, nicIds: ['another-host-nic'] };
    expect(() => plan(payload)).toThrow(/nicIds/);
  });
  it('permits the local domain controller resolver', () => {
    expect(validateHostDnsConfig({ servers: ['127.0.0.1'], nicIds: ['nic-primary'] }, ['nic-primary']).servers).toEqual(['127.0.0.1']);
  });
  it('preserves DNS server order and does not require AD SRV checks without a domain', () => {
    expect(validateHostDnsConfig({ servers: ['10.0.1.11', '10.0.1.10'], nicIds: ['nic-primary'] }, ['nic-primary'])).toEqual({ servers: ['10.0.1.11', '10.0.1.10'], nicIds: ['nic-primary'] });
  });
});
