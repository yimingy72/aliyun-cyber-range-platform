import type { AdminRepository, ProvisionJobRecord, RangeInstanceRecord, RangeResourceSummary } from './admin.repository';
import type { ResourceIdentity } from './resource-alert-types';
import { buildProvisionJobEvidence } from './provision-job-evidence';

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

export async function readPatrolInventories(repository: AdminRepository, instances: RangeInstanceRecord[], jobs: ProvisionJobRecord[],
  account: { provider: string; accountUid: string; cloudWorkspaceId: string }): Promise<ProvenInventory[]> {
  const result: ProvenInventory[] = [];
  for (const instance of instances) {
    if (instance.cloudWorkspaceId !== account.cloudWorkspaceId || instance.cloudProvider !== account.provider) continue;
    const instanceJobs = jobs.filter(job => job.rangeInstanceId === instance.id && job.cloudWorkspaceId === account.cloudWorkspaceId)
      .sort((a,b) => a.createdAt.getTime()-b.createdAt.getTime() || a.id.localeCompare(b.id));
    const contexts = new Map<string, ProvenInventory>();
    for (const job of instanceJobs) {
      if (!['create','retry','update'].includes(job.jobType) || !job.startedAt) continue;
      const steps = await repository.listProvisionJobStepLogs(job.id);
      const evidence = buildProvisionJobEvidence(job, steps, instanceJobs, []);
      const inventories: any[] = [...evidence.inventories];
      for (const step of steps.filter(step => step.cloudWorkspaceId === account.cloudWorkspaceId
        && step.stepName === 'platform_billing_creation_inventory' && step.status === 'succeeded')) {
        try {
          const value = JSON.parse(step.message ?? 'null');
          if (value?.version !== 1 || value.cloudWorkspaceId !== account.cloudWorkspaceId || value.rangeInstanceId !== instance.id
            || value.sourceJobId !== job.id || value.ownerUserId !== instance.ownerUserId || !Array.isArray(value.resources)) continue;
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
          inventories.push({ executionContext: value.executionContext, resources });
        } catch { /* Malformed historical evidence never authorizes deletion. */ }
      }
      for (const record of inventories) {
        const context = record.executionContext;
        if (context.provider !== account.provider || context.cloudAccountUid !== account.accountUid
          || !context.cloudAccountContextId || !context.regionId || !context.zoneId) continue;
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
        resources.forEach(resource => { current.proven.add(key(resource)); if (!current.birthSources.has(key(resource))) current.birthSources.set(key(resource),job.id); });
        current.resources = [...new Map([...current.resources,...resources].map(resource => [key(resource),resource])).values()];
        if (!current.sourceJobIds.includes(job.id)) current.sourceJobIds.push(job.id);
        contexts.set(source,current);
      }
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
      }
      result.push(inventory);
    }
  }
  return result;
}
export const patrolResourceKey = key;
