import type { EcsTemplateNode, ScenarioGraphNic, TemplateNode } from '../../../lib/scenario-graph';
import type { TemplateEdge } from './template-editor-screen';

/** Offline UI fixture: no platform IDs, credentials or cloud requests. */
export function createNetworkLayoutFixture() {
  const zones = [
    ['dmz', 'DMZ 交换机', '10.0.10.0/24'], ['office', '办公网络交换机', '172.16.20.0/24'],
    ['dev', '研发网络交换机', '172.16.30.0/24'], ['app', '业务服务交换机', '10.0.40.0/24'],
    ['storage', '数据存储交换机', '192.168.50.0/24'], ['ops', '运维管理交换机', '172.16.60.0/24'],
  ];
  const nodes: TemplateNode[] = [{ id: 'router', kind: 'router', label: '核心路由器', position: { x: 80, y: 80 }, routeRole: 'egress', egressType: 'internet', bindEip: true },
    ...zones.map(([id, label, cidr], index): TemplateNode => ({ id: `sw-${id}`, kind: 'switch', label: label!, cidr: cidr!, zoneKey: id!, purpose: id!,
      aclRules: [], nat: { snatEnabled: false, dnatMappings: [] }, position: { x: 396, y: 80 + index * 144 } }))];
  const edges: TemplateEdge[] = zones.map(([zone]) => ({ id: `router-${zone}`, fromNodeId: 'router', toNodeId: `sw-${zone}`, relationType: 'manual' }));
  const hosts: Array<[string, string, Array<[string, string]>]> = [
    ['gitlab', 'GitLab', [['dev', '172.16.30.10']]],
    ['harbor', 'Harbor 镜像仓库（研发基础设施服务）', [['dev', '172.16.30.11'], ['storage', '192.168.50.11']]],
    ['bastion', '运维堡垒机', [['ops', '172.16.60.10'], ['app', '10.0.40.11'], ['storage', '192.168.50.12']]],
    ['pc', '办公终端', [['office', '172.16.20.10'], ['dmz', '10.0.10.11']]],
    ['web', '公网 Web', [['dmz', '10.0.10.10']]], ['db', 'MySQL', [['storage', '192.168.50.10']]],
    ['nacos', 'Nacos', [['app', '10.0.40.10']]], ['spring', 'Spring Boot', [['app', '10.0.40.12']]],
    ['wiki', 'Wiki / Confluence', [['office', '172.16.20.12']]],
  ];
  for (const [index, [id, label, links]] of hosts.entries()) {
    const nics: ScenarioGraphNic[] = links.map(([zone, privateIp], ordinal) => ({ id: `${id}-nic-${ordinal + 1}`, switchId: `sw-${zone}`, zoneKey: zone,
      privateIp, secondaryIps: [], securityGroupRules: [], securityGroupRulesMode: 'default' }));
    const host: EcsTemplateNode = { id, kind: 'ecs', label, zoneKey: links[0]![0], privateIp: links[0]![1], nics, role: 'fixture', image: 'offline-fixture',
      exposePublic: false, networkInterfaces: [], dnatMappings: [], portGroups: [], initScript: '', imageStrategy: { mode: 'fixed', imageId: 'offline-fixture' },
      instanceTypeStrategy: { mode: 'auto' }, position: { x: 712, y: 80 + index * 144 } };
    nodes.push(host);
    links.forEach(([zone]) => edges.push({ id: `${zone}-${id}`, fromNodeId: `sw-${zone}`, toNodeId: id, relationType: 'manual' }));
  }
  return { nodes, edges };
}

export function createLargeNetworkLayoutFixture(hostCount = 80, zoneCount = 8) {
  const nodes: TemplateNode[] = [{ id: 'root', kind: 'router', label: '核心路由', routeRole: 'egress', egressType: 'internet', bindEip: false }];
  const edges: TemplateEdge[] = [];
  for (let index = 0; index < zoneCount; index++) {
    nodes.push({ id: `zone-${index}`, kind: 'switch', label: `网络区域 ${index}`, zoneKey: `zone-${index}`, cidr: `10.0.${index}.0/24`, purpose: 'fixture' });
    edges.push({ id: `root-${index}`, fromNodeId: 'root', toNodeId: `zone-${index}`, relationType: 'manual' });
  }
  const base = createNetworkLayoutFixture().nodes.find((node): node is EcsTemplateNode => node.kind === 'ecs')!;
  for (let index = 0; index < hostCount; index++) {
    const nics = Array.from({ length: index % 10 === 0 ? Math.min(3, zoneCount) : 1 }, (_, nicIndex) => {
      const zone = (index + nicIndex) % zoneCount;
      return { id: `host-${index}-nic-${nicIndex}`, switchId: `zone-${zone}`, zoneKey: `zone-${zone}`, privateIp: `10.0.${zone}.${index + 10}`,
        secondaryIps: [], securityGroupRules: [] };
    });
    nodes.push({ ...base, id: `host-${index}`, label: `靶机 ${index}`, nics, privateIp: nics[0]!.privateIp, zoneKey: nics[0]!.zoneKey, position: undefined });
    nics.forEach(nic => edges.push({ id: `${nic.switchId}-host-${index}`, fromNodeId: nic.switchId, toNodeId: `host-${index}`, relationType: 'manual' }));
  }
  return { nodes, edges };
}
