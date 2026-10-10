import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { ProvisionJobTopologySnapshot, RangeInstanceRecord, RangeResourceSummary } from './admin.repository';

const mapKeys = ['hostIds', 'systemDiskIds', 'dataDiskIds', 'subnetIds', 'networkAclIds', 'securityGroupIds', 'secondaryNetworkInterfaceIds', 'natGatewayIds', 'snatEntryIds', 'dnatEntryIds', 'eipAllocationIds', 'routeTableIds'] as const;
function normalize(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(normalize);
 if (!value || typeof value !== 'object') return value ?? null;
 return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]));
}
export const rangeChangeDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(normalize(value))).digest('base64url');
const nodes = (graph: Record<string, unknown> | null | undefined) => (Array.isArray(graph?.nodes) ? graph!.nodes : []) as Record<string, any>[];
const pick = (value: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, value[key] ?? null]));
function inventory(summary: RangeResourceSummary | null | undefined): Record<string, unknown> {
 return { ...pick(summary ?? {}, ['mode', 'vpcId', 'eipAllocationId', 'executionContext', ...mapKeys]), retiredResources: summary?.retiredResources ? inventory(summary.retiredResources) : null };
}
export function rangeRuntimeIdentityDigest(instance: RangeInstanceRecord) {
 return rangeChangeDigest({ id: instance.id, cloudWorkspaceId: instance.cloudWorkspaceId, cloudProvider: instance.cloudProvider,
  runtimeTopologyGraph: instance.runtimeTopologyGraph, runtimeScenarioTemplateSpec: instance.runtimeScenarioTemplateSpec,
  runtimeCompiledProvisionSpec: instance.runtimeCompiledProvisionSpec, runtimeCredentials: instance.runtimeCredentials,
  inventory: inventory(instance.resourceSummary), expiresAt: instance.expiresAt?.toISOString() ?? null });
}
export function rangeDraftSourceDigest(instance: RangeInstanceRecord, actorUserId: string, cloudWorkspaceId: string) {
 return rangeChangeDigest({ actorUserId, cloudWorkspaceId, runtime: rangeRuntimeIdentityDigest(instance), status: instance.status,
  ownerUserId: instance.ownerUserId, lastJobId: instance.lastJobId, draftRevision: instance.draftRevision,
  draftTopologyGraph: instance.draftTopologyGraph, draftTopologySpec: instance.draftTopologySpec,
  draftScenarioTemplateSpec: instance.draftScenarioTemplateSpec, draftCompiledProvisionSpec: instance.draftCompiledProvisionSpec });
}
export function rangeTopologyDigest(snapshot: ProvisionJobTopologySnapshot) {
 return rangeChangeDigest(pick(snapshot, ['draftRevision', 'topologyGraph', 'topologySpec', 'scenarioTemplateSpec', 'compiledProvisionSpec', 'compiledSpec', 'templateModulePath']));
}
export type RangeChangeApproval = { version: 1; addedHostKeys: string[]; deletedHostKeys: string[]; runtimeIdentityDigest: string; topologyDigest: string; allowDnatRemoval: boolean; allowSnatRemoval: boolean };
const keys = (spec: Record<string, any> | null | undefined, field: string) => (Array.isArray(spec?.[field]) ? spec![field] : []).map((entry: any) => entry.key as string);
export function buildRangeChangeApproval(instance: RangeInstanceRecord, snapshot: ProvisionJobTopologySnapshot): RangeChangeApproval {
 const before = nodes(instance.runtimeTopologyGraph); const after = nodes(snapshot.topologyGraph);
 const beforeIds = before.filter(node => node.kind === 'ecs').map(node => node.id as string);
 const afterIds = after.filter(node => node.kind === 'ecs').map(node => node.id as string);
 const deployed = new Map(before.map(node => [node.id, node]));
 for (const node of after) {
  const old = deployed.get(node.id); if (!old) continue;
  if (old.kind !== node.kind) throw new ConflictException('已部署节点不能改变节点类型。');
  if (node.kind === 'switch' && rangeChangeDigest(pick(old, ['zoneKey', 'cidr'])) !== rangeChangeDigest(pick(node, ['zoneKey', 'cidr']))) throw new ConflictException('运行交换机的网段和网络标识不能修改。');
  if (node.kind !== 'ecs') continue;
  const identity = (host: Record<string, any>) => ({ ...pick(host, ['zoneKey', 'privateIp', 'image', 'imageName', 'imageId', 'platformImageAssetId', 'imageStrategy', 'cpu', 'memory', 'instanceType', 'instanceTypeStrategy', 'hostName', 'customPassword', 'initScript', 'dns', 'bootPriority', 'bootWaitSeconds', 'networkInterfaces']),
   nics: (host.nics ?? []).map((nic: Record<string, any>) => pick(nic, ['id', 'switchId', 'zoneKey', 'privateIp', 'secondaryIps'])) });
  if (rangeChangeDigest(identity(old)) !== rangeChangeDigest(identity(node))) throw new ConflictException(`运行主机“${old.label ?? old.id}”的镜像、规格、网卡身份、DNS 和启动配置不能修改；请新增主机。`);
 }
 // Removing networks would destroy the environment independently of explicit host removal.
 if (before.some(node => node.kind !== 'ecs' && !after.some(current => current.id === node.id))) throw new ConflictException('运行拓扑不能删除交换机或路由器。');
 const addedHostKeys = afterIds.filter(key => !beforeIds.includes(key));
 const deletedHostKeys = beforeIds.filter(key => !afterIds.includes(key));
 if (addedHostKeys.length && (!instance.expiresAt || instance.expiresAt.getTime() <= Date.now())) throw new ConflictException('新增主机必须继承有效的编排到期时间。');
 if (Object.keys(instance.resourceSummary?.hostIds ?? {}).some(key => !beforeIds.includes(key))) throw new ConflictException('原主机清单与已部署拓扑不一致，请先核验资源。');
 const removed = (field: string) => keys(instance.runtimeCompiledProvisionSpec, field).some(key => !keys(snapshot.compiledProvisionSpec, field).includes(key));
 return { version: 1, addedHostKeys, deletedHostKeys, runtimeIdentityDigest: rangeRuntimeIdentityDigest(instance), topologyDigest: rangeTopologyDigest(snapshot), allowDnatRemoval: removed('dnatEntries'), allowSnatRemoval: removed('snatEntries') };
}
export function expectedRangeChangeSummary(instance: RangeInstanceRecord, snapshot: ProvisionJobTopologySnapshot, approval: RangeChangeApproval) {
 const before = nodes(instance.runtimeTopologyGraph); const after = nodes(snapshot.topologyGraph);
 const describe = (key: string, source: Record<string, any>[]) => ({ id: key, nodeId: key, name: source.find(node => node.id === key)?.label ?? key });
 const resourceChanges: Array<{ resourceType: string; key: string; action: 'create' | 'delete'; resourceId?: string }> = [];
 for (const [field, ids] of [['natGateways', 'natGatewayIds'], ['eips', 'eipAllocationIds'], ['snatEntries', 'snatEntryIds'], ['dnatEntries', 'dnatEntryIds']] as const) {
  const oldKeys = keys(instance.runtimeCompiledProvisionSpec, field); const newKeys = keys(snapshot.compiledProvisionSpec, field);
  for (const key of newKeys.filter(key => !oldKeys.includes(key))) resourceChanges.push({ resourceType: field, key, action: 'create' });
  for (const key of oldKeys.filter(key => !newKeys.includes(key))) resourceChanges.push({ resourceType: field, key, action: 'delete', resourceId: instance.resourceSummary?.[ids]?.[key] });
 }
 const deletedHosts = approval.deletedHostKeys.map(key => ({ ...describe(key, before), instanceId: instance.resourceSummary?.hostIds?.[key] ?? null,
  systemDiskId: instance.resourceSummary?.systemDiskIds?.[key] ?? null,
  dataDiskIds: Object.entries(instance.resourceSummary?.dataDiskIds ?? {}).filter(([entry]) => entry === key || entry.startsWith(`${key}:`)).map(([, id]) => id),
  networkInterfaceIds: Object.entries(instance.resourceSummary?.secondaryNetworkInterfaceIds ?? {}).filter(([entry]) => entry === key || entry.startsWith(`${key}-`) || entry.startsWith(`${key}:`)).map(([, id]) => id) }));
 const ruleChanges = after.filter(node => {
  const old = before.find(value => value.id === node.id); if (!old) return false;
  const rules = (entry: Record<string, any>) => entry.kind === 'switch' ? pick(entry, ['aclRules', 'nat']) : entry.kind === 'ecs' ? { portGroups: entry.portGroups, nics: (entry.nics ?? []).map((nic: any) => pick(nic, ['id', 'securityGroupRulesMode', 'securityGroupRules'])) } : pick(entry, ['routeRole', 'egressType', 'bindEip']);
  return rangeChangeDigest(rules(old)) !== rangeChangeDigest(rules(node));
 }).map(node => ({ nodeId: node.id, name: node.label ?? node.id, nodeKind: node.kind }));
 for (const host of deletedHosts) (host as any).diskIds = [...(host.systemDiskId ? [host.systemDiskId] : []), ...host.dataDiskIds];
 return { allowDnatRemoval: approval.allowDnatRemoval, allowSnatRemoval: approval.allowSnatRemoval, id: instance.id, rangeInstanceId: instance.id, kind: 'expected-topology-diff' as const, expectedDraftRevision: snapshot.draftRevision,
  addedNetworks: after.filter(node => node.kind === 'switch' && !before.some(old => old.id === node.id)).map(node => ({ nodeId: node.id as string, name: (node.label ?? node.id) as string, zoneKey: node.zoneKey as string, cidr: node.cidr as string })),
  addedHosts: approval.addedHostKeys.map(key => ({ ...describe(key, after), expiresAt: instance.expiresAt?.toISOString() ?? null })), deletedHosts, ruleChanges, resourceChanges };
}
