import type { AdminRepository, ProvisionJobRecord, ProvisionJobStepLogRecord, RangeInstanceRecord, RangeResourceSummary } from './admin.repository';
import type { ResourceIdentity } from './resource-alert-types';
import { buildProvisionJobEvidence } from './provision-job-evidence';
import { isIPv4 } from 'node:net';

const maps = { hostIds: 'ecs', systemDiskIds: 'disk', subnetIds: 'vswitch', securityGroupIds: 'security_group', networkAclIds: 'network_acl',
  secondaryNetworkInterfaceIds: 'eni', natGatewayIds: 'nat_gateway', snatEntryIds: 'snat_entry', dnatEntryIds: 'dnat_entry',
  eipAllocationIds: 'eip', routeTableIds: 'route_table' } as const;
const key = (resource: ResourceIdentity) => `${resource.type}:${resource.id}`;
export function patrolResourceIdentities(summary: Record<string,any> | null | undefined): ResourceIdentity[] {
  const result: ResourceIdentity[] = [];
  for (const [field,type] of Object.entries(maps)) for (const id of Object.values(summary?.[field] ?? {})) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('INVALID_PERSISTED_RESOURCE_ID');
    result.push({ type: type as ResourceIdentity['type'], id });
  }
  for (const [field,type] of [['vpcId','vpc'],['eipAllocationId','eip']] as const) if (summary?.[field]) {
    if (typeof summary[field] !== 'string') throw new Error('INVALID_PERSISTED_RESOURCE_ID');
    result.push({ type, id: summary[field] });
  }
  if (summary?.retiredResources) result.push(...patrolResourceIdentities(summary.retiredResources));
  return [...new Map(result.map(resource => [key(resource),resource])).values()];
}
export type ProvenInventory = { instance: RangeInstanceRecord; context: { provider: string; cloudAccountUid: string; cloudAccountContextId: string; regionId: string; zoneId: string };
  summary: RangeResourceSummary; resources: ResourceIdentity[]; sourceJobIds: string[]; proven: Set<string>; birthSources: Map<string,string> };

const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const providerTypes: Record<string, ResourceIdentity['type']> = {
  alicloud_instance:'ecs',tencentcloud_instance:'ecs',alicloud_vpc:'vpc',tencentcloud_vpc:'vpc',alicloud_vswitch:'vswitch',tencentcloud_subnet:'vswitch',
  alicloud_security_group:'security_group',tencentcloud_security_group:'security_group',alicloud_network_acl:'network_acl',tencentcloud_vpc_acl:'network_acl',
  alicloud_network_interface:'eni',tencentcloud_eni:'eni',alicloud_nat_gateway:'nat_gateway',tencentcloud_nat_gateway:'nat_gateway',alicloud_eip_address:'eip',tencentcloud_eip:'eip',
  alicloud_route_table:'route_table',tencentcloud_route_table:'route_table',alicloud_snat_entry:'snat_entry',tencentcloud_nat_gateway_snat:'snat_entry',
  alicloud_forward_entry:'dnat_entry',tencentcloud_dnat:'dnat_entry',
};
function canGrantCreationInventory(job: ProvisionJobRecord) {
  return job.jobType === 'create' && !['destroy','update'].includes(job.topologySnapshot?.operation ?? '')
    || job.jobType === 'retry' && job.topologySnapshot?.operation === 'create';
}
function canGrantCreationReceipt(job: ProvisionJobRecord, instance: RangeInstanceRecord, single: boolean) {
  if (job.topologySnapshot?.operation === 'destroy' || job.jobType === 'destroy' || job.jobType === 'refresh_status') return false;
  if (job.jobType === 'create' || job.jobType === 'update') return !single || instance.instanceMode === 'single';
  return job.jobType === 'retry' && (job.topologySnapshot?.operation === 'create'
    || single && instance.instanceMode === 'single' && job.topologySnapshot?.operation === undefined);
}
function receiptResources(value: any, provider: string): ResourceIdentity[] {
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > 10000) throw new Error('INVALID_CREATION_RECEIPT');
  const resources: ResourceIdentity[] = [];
  for (const row of value.resources) {
    if (!object(row) || !Object.hasOwn(providerTypes, row.providerResourceType) || providerTypes[row.providerResourceType] !== row.type
      || !(provider === 'alibaba_cloud' ? row.providerResourceType?.startsWith('alicloud_') : row.providerResourceType?.startsWith('tencentcloud_'))
      || typeof row.address !== 'string' || row.address.length > 4096 || /[\x00-\x1f]/.test(row.address)
      || !row.address.startsWith(`module.range.${row.providerResourceType}.`) || typeof row.id !== 'string' || row.id.length > 256
      || (row.action !== undefined && row.action !== 'create')) throw new Error('INVALID_CREATION_RECEIPT');
    if (row.type === 'snat_entry' && provider === 'tencent_cloud') {
      if (!/^nat-[a-z0-9]+#subnet-[a-z0-9]+$/.test(row.id)) throw new Error('INVALID_CREATION_RECEIPT');
    } else if (row.type === 'dnat_entry' && provider === 'tencent_cloud') {
      const match = row.id.match(/^(TCP|UDP):\/\/vpc-[a-z0-9]+:nat-[a-z0-9]+@([0-9.]+):([1-9]\d{0,4})$/);
      if (!match || !isIPv4(match[2]) || Number(match[3]) > 65535) throw new Error('INVALID_CREATION_RECEIPT');
    } else if (row.type === 'snat_entry' || row.type === 'dnat_entry') {
      if (!(row.type === 'snat_entry' ? /^stb-[A-Za-z0-9]+:snat-[A-Za-z0-9]+$/ : /^ftb-[A-Za-z0-9]+:fwd-[A-Za-z0-9]+$/).test(row.id)) throw new Error('INVALID_CREATION_RECEIPT');
    } else {
      const prefixes: Record<string,string> = {ecs:provider==='alibaba_cloud'?'i':'ins',vpc:'vpc',vswitch:provider==='alibaba_cloud'?'vsw':'subnet',
        security_group:'sg',network_acl:provider==='alibaba_cloud'?'nacl':'acl',eni:'eni',nat_gateway:provider==='alibaba_cloud'?'ngw':'nat',eip:'eip',route_table:provider==='alibaba_cloud'?'vtb':'rtb'};
      if (!new RegExp(`^${prefixes[row.type]}-[A-Za-z0-9-]+$`).test(row.id)) throw new Error('INVALID_CREATION_RECEIPT');
    }
    resources.push({type:row.type,id:row.id});
  }
  if (new Set(resources.map(key)).size !== resources.length) throw new Error('INVALID_CREATION_RECEIPT');
  return resources;
}
function parseStep(step: ProvisionJobStepLogRecord, job: ProvisionJobRecord, instance: RangeInstanceRecord, workspace: string) {
  if (step.jobId !== job.id || step.cloudWorkspaceId !== workspace || step.status !== 'succeeded' || !step.message || step.message.length > 1024 * 1024) return null;
  try {
    const value = JSON.parse(step.message);
    if (!object(value) || value.version !== 1 || value.rangeInstanceId !== instance.id || !object(value.executionContext)
      || value.cloudWorkspaceId !== undefined && value.cloudWorkspaceId !== workspace
      || value.sourceJobId !== undefined && value.sourceJobId !== job.id
      || value.cloudProvider !== undefined && value.cloudProvider !== instance.cloudProvider
      || value.ownerUserId !== undefined && value.ownerUserId !== instance.ownerUserId) return null;
    return value;
  } catch { return null; }
}
function contextMatches(context: any, account: {provider:string;accountUid:string}) {
  return object(context) && context.provider === account.provider && context.cloudAccountUid === account.accountUid
    && ['cloudAccountContextId', 'regionId', 'zoneId'].every(field => typeof context[field] === 'string' && context[field] && context[field].length <= 192);
}

export async function readPatrolInventories(repository: AdminRepository, instances: RangeInstanceRecord[], jobs: ProvisionJobRecord[],
  account: { provider: string; accountUid: string; cloudWorkspaceId: string }): Promise<ProvenInventory[]> {
  const result: ProvenInventory[] = [];
  for (const instance of instances) {
    if (instance.cloudWorkspaceId !== account.cloudWorkspaceId || instance.cloudProvider !== account.provider) continue;
    const instanceJobs = jobs.filter(job => job.rangeInstanceId === instance.id && job.cloudWorkspaceId === account.cloudWorkspaceId)
      .sort((a,b) => a.createdAt.getTime()-b.createdAt.getTime() || a.id.localeCompare(b.id));
    const contexts = new Map<string, ProvenInventory>();
    for (const job of instanceJobs) {
      if (!job.startedAt) continue;
      const steps = await repository.listProvisionJobStepLogs(job.id);
      const inventories: Array<{ executionContext: any; resources: any; grants: ResourceIdentity[] }> = [];
      for (const step of steps) {
        const value = parseStep(step, job, instance, account.cloudWorkspaceId);
        if (!value) continue;
        try {
          if (step.stepName === 'range_resource_creation_receipt') {
            if (instance.instanceMode !== 'range' || value.cloudWorkspaceId !== account.cloudWorkspaceId || value.sourceJobId !== job.id
              || value.cloudProvider !== account.provider || value.ownerUserId !== instance.ownerUserId
              || value.action !== undefined && value.action !== 'create') continue;
            const received = receiptResources(value, account.provider), resources: Record<string, any> = {};
            for (const receivedResource of received) {
              if (receivedResource.type === 'vpc') resources.vpcId = receivedResource.id;
              else {
                const mapping = Object.entries(maps).find(([, type]) => type === receivedResource.type)!;
                const receivedRow = value.resources.find((row: any) => row.type === receivedResource.type && row.id === receivedResource.id);
                (resources[mapping[0]] ??= Object.create(null))[receivedRow.logicalKey ?? receivedResource.id] = receivedResource.id;
              }
            }
            inventories.push({ executionContext: value.executionContext, resources,
              grants: canGrantCreationReceipt(job, instance, false) ? received : [] });
            continue;
          }
          if (['range_resource_inventory', 'single_instance_creation_receipt'].includes(step.stepName)) {
            const projected = buildProvisionJobEvidence(job, [step], instanceJobs, []).inventories[0];
            if (!projected) continue;
            const singleReceipt = step.stepName === 'single_instance_creation_receipt';
            if (singleReceipt && value.action !== undefined && value.action !== 'create') continue;
            const resources = singleReceipt ? { hostIds: projected.resources.hostIds ?? {} }
              : { ...projected.resources, ...(object(value.resources?.diskOwnershipProofs) ? { diskOwnershipProofs: value.resources.diskOwnershipProofs } : {}) };
            inventories.push({ executionContext: projected.executionContext, resources,
              grants: (singleReceipt ? canGrantCreationReceipt(job, instance, true) : canGrantCreationInventory(job)) ? patrolResourceIdentities(resources) : [] });
            continue;
          }
          if (step.stepName !== 'platform_billing_creation_inventory' || value.sourceJobId !== job.id || !Array.isArray(value.resources)) continue;
          const resources: Record<string,any> = {};
          for (const item of value.resources) {
            const mapping = Object.entries(maps).find(([,type]) => type === item.cloudResourceType);
            if (mapping && typeof item.cloudResourceId === 'string') {
              const hostKey = instance.instanceMode === 'single' && instance.singleInstanceConfig?.hostKey
                && ['ecs','disk'].includes(item.cloudResourceType) ? instance.singleInstanceConfig.hostKey : item.cloudResourceId;
              (resources[mapping[0]] ??= {})[hostKey] = item.cloudResourceId;
            }
          }
          if (value.diskAttachments && typeof value.diskAttachments === 'object') {
            resources.diskOwnershipProofs = {};
            resources.diskInventoryHostIds = {};
            for (const [id,attachment] of Object.entries(value.diskAttachments) as Array<[string,any]>) {
              if (typeof attachment?.instanceId !== 'string' || !Object.values(resources.hostIds ?? {}).includes(attachment.instanceId)
                || !['persisted','tags'].includes(attachment.method)) continue;
              resources.diskOwnershipProofs[id] = { instanceId: attachment.instanceId, method: attachment.method };
              resources.diskInventoryHostIds[instance.singleInstanceConfig?.hostKey ?? attachment.instanceId] = attachment.instanceId;
            }
          }
          inventories.push({ executionContext: value.executionContext, resources,
            grants: canGrantCreationInventory(job) ? patrolResourceIdentities(resources) : [] });
        } catch { /* Malformed historical evidence never authorizes deletion. */ }
      }
      // Collect actual create receipts before deriving implicit system disks,
      // regardless of callback/log ordering. Observation alone cannot adopt a disk.
      const createdHosts = new Map<string, Set<string>>();
      for (const record of inventories) {
        const context = record.executionContext;
        if (!contextMatches(context, account)) continue;
        const source = `${context.regionId}:${context.cloudAccountContextId}`;
        const hosts = createdHosts.get(source) ?? new Set<string>();
        for (const resource of record.grants) if (resource.type === 'ecs') hosts.add(resource.id);
        createdHosts.set(source, hosts);
      }
      for (const record of inventories) {
        const context = record.executionContext;
        if (!contextMatches(context, account)) continue;
        let resources: ResourceIdentity[];
        try { resources = patrolResourceIdentities(record.resources); } catch { continue; }
        const source = `${context.regionId}:${context.cloudAccountContextId}`;
        const current = contexts.get(source) ?? { instance, context, summary: { mode: 'opentofu', executionContext: context },
          resources: [], sourceJobIds: [], proven: new Set<string>(), birthSources: new Map<string,string>() } as ProvenInventory;
        for (const [field,value] of Object.entries(record.resources)) {
          if (field in maps && value && typeof value === 'object') {
            // Keep distinct physical generations; do not replace an earlier host ID with a later one.
            const target = ((current.summary as any)[field] ??= {});
            for (const [node,id] of Object.entries(value as Record<string,unknown>)) target[target[node] && target[node] !== id ? `observed:${node}:${id}` : node] = id;
          } else if (['vpcId','eipAllocationId'].includes(field) && typeof value === 'string') {
            if ((current.summary as any)[field] && (current.summary as any)[field] !== value) continue;
            (current.summary as any)[field] = value;
          } else if (['diskOwnershipProofs','diskInventoryHostIds'].includes(field)) (current.summary as any)[field] = { ...(current.summary as any)[field], ...(value as object) };
        }
        const grants = [...record.grants];
        for (const [node, id] of Object.entries(record.resources.systemDiskIds ?? {})) {
          const proof = record.resources.diskOwnershipProofs?.[String(id)], hostId = proof?.instanceId;
          if (typeof id === 'string' && object(proof) && proof.method === 'persisted' && typeof hostId === 'string'
            && createdHosts.get(source)?.has(hostId) && record.resources.hostIds?.[node] === hostId
            && record.resources.diskInventoryHostIds?.[node] === hostId) grants.push({type:'disk',id});
        }
        grants.forEach(resource => { current.proven.add(key(resource)); if (!current.birthSources.has(key(resource))) current.birthSources.set(key(resource),job.id); });
        current.resources = [...new Map([...current.resources,...resources].map(resource => [key(resource),resource])).values()];
        if (!current.sourceJobIds.includes(job.id)) current.sourceJobIds.push(job.id);
        contexts.set(source,current);
      }
    }
    // The current exact IDs are useful for tag-loss discovery even when no
    // creation log survived. They are observations, never birth evidence.
    const runtime = instance.resourceSummary?.executionContext;
    if (runtime?.cloudAccountUid === account.accountUid && runtime.cloudAccountContextId && runtime.regionId) {
      const source = `${runtime.regionId}:${runtime.cloudAccountContextId}`;
      if (!contexts.has(source)) contexts.set(source, { instance, context: { provider: account.provider, ...runtime, zoneId: runtime.zoneId ?? '' },
        summary: { mode: 'opentofu', executionContext: runtime }, resources: [], sourceJobIds: [], proven: new Set(), birthSources: new Map() } as ProvenInventory);
    }
    for (const inventory of contexts.values()) {
      // Current runtime configuration is preserved, including disk relationship and deadline metadata.
      const current = instance.resourceSummary;
      if (current?.executionContext?.cloudAccountUid === account.accountUid
        && current.executionContext.regionId === inventory.context.regionId && current.executionContext.cloudAccountContextId === inventory.context.cloudAccountContextId) {
        const history=inventory.summary;
        inventory.summary = { ...history, ...current };
        for (const field of Object.keys(maps)) {
          const target={...((history as any)[field] ?? {})};
          for (const [node,id] of Object.entries((current as any)[field] ?? {})) target[target[node] && target[node]!==id ? `observed:${node}` : node]=id;
          if (Object.keys(target).length) (inventory.summary as any)[field]=target;
        }
        for (const field of ['diskOwnershipProofs','diskInventoryHostIds']) (inventory.summary as any)[field] = { ...(history as any)[field], ...(current as any)[field] };
        inventory.resources = [...new Map([...inventory.resources, ...patrolResourceIdentities(current)].map(resource => [key(resource),resource])).values()];
      }
      result.push(inventory);
    }
  }
  return result;
}
export const patrolResourceKey = key;
