import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime/compiled';

const select = (value: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
const base = ['id', 'kind', 'label', 'position'];
const rule = ['key', 'direction', 'protocol', 'portRange', 'sourceCidr', 'destinationCidr', 'policy', 'priority', 'description'];
const mapping = ['key', 'targetHostId', 'externalPort', 'internalPort', 'protocol', 'description'];

// A deployed graph may carry UI/runtime annotations. Export only authoring fields.
export function portableRangeTemplateGraph(value: Record<string, unknown>): ScenarioGraphDraft {
 const graph = value as Record<string, any>;
 return {
  schemaVersion: graph.schemaVersion,
  nodes: graph.nodes.map((node: Record<string, any>) => {
   if (node.kind === 'router') return select(node, [...base, 'description', 'routeRole', 'egressType', 'bindEip']);
   if (node.kind === 'switch') return { ...select(node, [...base, 'zoneKey', 'cidr', 'purpose', 'description', 'enableNat', 'snatEnabled', 'snatNatGatewayKey', 'snatEipKey']),
    ...(node.aclRules ? { aclRules: node.aclRules.map((entry: Record<string, any>) => select(entry, rule)) } : {}),
    ...(node.nat ? { nat: { snatEnabled: node.nat.snatEnabled, dnatMappings: node.nat.dnatMappings.map((entry: Record<string, any>) => select(entry, mapping)) } } : {}) };
   return { ...select(node, [...base, 'zoneKey', 'role', 'privateIp', 'exposePublic', 'image', 'platformImageAssetId', 'instanceName', 'hostName', 'imageName', 'imageId', 'cpu', 'memory', 'instanceType', 'description', 'bootPriority', 'bootWaitSeconds', 'initScript']),
    imageStrategy: select(node.imageStrategy ?? {}, ['mode', 'imageId', 'preferredImageIds']),
    instanceTypeStrategy: select(node.instanceTypeStrategy ?? {}, ['mode', 'instanceType', 'preferredInstanceTypes']),
    dnatMappings: (node.dnatMappings ?? []).map((entry: Record<string, any>) => select(entry, ['name', 'natGatewayKey', 'eipKey', 'externalPort', 'internalPort', 'protocol'])),
    networkInterfaces: (node.networkInterfaces ?? []).map((entry: Record<string, any>) => select(entry, ['zoneKey', 'privateIp'])),
    portGroups: (node.portGroups ?? []).map((entry: Record<string, any>) => select(entry, ['name', 'protocol', 'portRange', 'sourceCidr'])),
    ...(node.dns ? { dns: select(node.dns, ['servers', 'nicIds', 'domain']) } : {}),
    ...(node.nics ? { nics: node.nics.map((nic: Record<string, any>) => ({ ...select(nic, ['id', 'switchId', 'zoneKey', 'privateIp', 'secondaryIps', 'securityGroupRulesMode']), securityGroupRules: (nic.securityGroupRules ?? []).map((entry: Record<string, any>) => select(entry, rule.filter(key => key !== 'destinationCidr'))) })) } : {}),
   };
  }),
  edges: graph.edges.map((edge: Record<string, any>) => select(edge, ['id', 'fromNodeId', 'toNodeId', 'relationType', 'label'])),
  ...(graph.viewport ? { viewport: select(graph.viewport, ['x', 'y', 'zoom']) } : {}),
 } as ScenarioGraphDraft;
}
