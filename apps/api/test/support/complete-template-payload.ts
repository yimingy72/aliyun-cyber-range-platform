import { compileTemplateTopology, type ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime/compiled';
import type { RangeTemplateCompiledSpec, RangeTemplateTopologySpec } from '../../src/admin/admin.repository';

export function completeTemplatePayload(
  topology: RangeTemplateTopologySpec,
  image = { id: 'asset-1', imageId: 'image-1', displayName: 'Fixture Image' },
) {
  const switches = topology.networkZones.map((zone, index) => ({
    id: `switch-${index + 1}`, kind: 'switch' as const, label: zone.name, zoneKey: zone.key,
    cidr: zone.cidr, purpose: zone.purpose, aclRules: [], nat: {
      snatEnabled: false,
      dnatMappings: zone.key === topology.hosts.find((host) => host.key === topology.publicEntry.hostKey)!.zoneKey
        ? [{ key: 'entry-ssh', targetHostId: topology.publicEntry.hostKey, protocol: 'tcp' as const, externalPort: 22, internalPort: 22 }]
        : [],
    },
  }));
  const hosts = topology.hosts.map((host) => ({
    id: host.key, kind: 'ecs' as const, label: host.name, hostName: host.hostName ?? undefined,
    zoneKey: host.zoneKey, role: host.role, privateIp: host.privateIp,
    exposePublic: host.key === topology.publicEntry.hostKey,
    image: image.displayName, imageName: image.displayName, imageId: image.imageId,
    platformImageAssetId: image.id, imageStrategy: { mode: 'fixed' as const, imageId: image.imageId },
    instanceTypeStrategy: { mode: 'auto' as const }, nics: [{
      id: `${host.key}-nic`, switchId: switches.find((node) => node.zoneKey === host.zoneKey)!.id,
      privateIp: host.privateIp, secondaryIps: [], securityGroupRules: [],
    }], dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
  }));
  const graph: ScenarioGraphDraft = {
    schemaVersion: '2.0.0',
    nodes: [{ id: 'router', kind: 'router', label: 'Router', routeRole: 'egress', egressType: 'internet', bindEip: false }, ...switches, ...hosts],
    edges: [
      ...switches.map((node) => ({ id: `router-${node.id}`, fromNodeId: 'router', toNodeId: node.id, relationType: 'manual' as const })),
      ...hosts.map((node) => ({ id: `edge-${node.id}`, fromNodeId: node.nics[0]!.switchId, toNodeId: node.id, relationType: 'manual' as const })),
    ],
  };
  const compiled = JSON.parse(JSON.stringify(compileTemplateTopology(graph, {
    name: 'Template 1', slug: 'template-1', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    primaryVpcCidr: topology.vpcCidr, secondaryVpcCidrs: [], publicEntryProtocols: topology.publicEntry.protocols,
  }))) as ReturnType<typeof compileTemplateTopology>;
  return {
    topologyGraph: compiled.topologyGraph as unknown as Record<string, unknown>,
    topologySpec: compiled.topologySpec as RangeTemplateTopologySpec,
    scenarioTemplateSpec: compiled.scenarioTemplateSpec,
    compiledProvisionSpec: compiled.compiledProvisionSpec,
    compiledSpec: compiled.compiledSpec as RangeTemplateCompiledSpec,
  };
}
