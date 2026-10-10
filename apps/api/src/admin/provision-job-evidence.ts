import type { BillingLedgerResourceRecord, ProvisionJobRecord, ProvisionJobStepLogRecord } from './admin.repository';

const descriptions: Record<string, string> = {
  prepare: 'Prepare the recorded operation', tofu_init: 'Initialize OpenTofu', tofu_apply: 'Apply the recorded topology',
  tofu_destroy: 'Destroy the recorded topology', verify_destroy: 'Platform cloud absence verification',
  persist_access_entry: 'Persist cloud resources and billing sources', range_resource_inventory: 'Persist resource identities',
  cleanup_failed_create_resources: 'Clean up partial creation',
};
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const maps = ['routeTableIds', 'subnetIds', 'networkAclIds', 'securityGroupIds', 'hostIds', 'systemDiskIds', 'dataDiskIds',
  'unverifiedDiskIds', 'diskInventoryHostIds', 'secondaryNetworkInterfaceIds', 'natGatewayIds', 'snatEntryIds', 'dnatEntryIds', 'eipAllocationIds'];

function resourceIds(value: unknown, depth = 0): Record<string, unknown> {
  if (!object(value) || depth > 1) throw new Error('Invalid inventory');
  const result: Record<string, unknown> = {};
  for (const field of ['vpcId', 'eipAllocationId']) if (value[field] != null) {
    if (!identity(value[field])) throw new Error('Invalid resource ID');
    result[field] = value[field];
  }
  for (const field of maps) if (value[field] != null) {
    if (!object(value[field]) || Object.keys(value[field]).length > 1000) throw new Error('Invalid resource map');
    const entries = Object.entries(value[field]);
    if (entries.some(([key, id]) => !identity(key) || !identity(id))) throw new Error('Invalid resource identity');
    result[field] = Object.fromEntries(entries);
  }
  if (value.retiredResources != null) result.retiredResources = resourceIds(value.retiredResources, depth + 1);
  return result;
}

function inventory(step: ProvisionJobStepLogRecord, rangeInstanceId: string) {
  if (!step.message || step.message.length > 1024 * 1024) throw new Error('Missing inventory');
  const value: unknown = JSON.parse(step.message);
  if (!object(value) || value.version !== 1 || value.rangeInstanceId !== rangeInstanceId || !object(value.executionContext)) throw new Error('Invalid inventory source');
  const context = value.executionContext;
  if (!['alibaba_cloud', 'tencent_cloud'].includes(String(context.provider))
    || ['cloudAccountContextId', 'cloudAccountUid', 'regionId', 'zoneId'].some(key => !identity(context[key]))) throw new Error('Invalid frozen context');
  return { recordedAt: step.createdAt, executionContext: Object.fromEntries(['provider', 'cloudAccountContextId', 'cloudAccountUid', 'regionId', 'zoneId'].map(key => [key, context[key]])),
    resources: resourceIds(value.resources) };
}

// Deliberately project identities and fixed phase descriptions; raw logs and provider output may contain secrets.
export function buildProvisionJobEvidence(job: ProvisionJobRecord, steps: ProvisionJobStepLogRecord[], jobs: ProvisionJobRecord[], ledgers: BillingLedgerResourceRecord[]) {
  const scopedSteps = steps.filter(step => step.jobId === job.id && step.cloudWorkspaceId === job.cloudWorkspaceId);
  const inventories: ReturnType<typeof inventory>[] = [];
  let invalidInventoryCount = 0;
  for (const step of scopedSteps.filter(step => step.stepName === 'range_resource_inventory' && step.status === 'succeeded')) {
    try { inventories.push(inventory(step, job.rangeInstanceId)); } catch { invalidInventoryCount++; }
  }
  return { coverage: 'platform_recorded_job_evidence' as const, inventories, invalidInventoryCount,
    steps: scopedSteps.filter(step => Object.prototype.hasOwnProperty.call(descriptions, step.stepName)).map(step => ({
      stepName: step.stepName, status: step.status, description: descriptions[step.stepName], startedAt: step.startedAt, finishedAt: step.finishedAt })),
    relatedJobs: jobs.filter(item => item.rangeInstanceId === job.rangeInstanceId && item.cloudWorkspaceId === job.cloudWorkspaceId).map(item => ({
      id: item.id, jobType: item.jobType, status: item.status, createdAt: item.createdAt, startedAt: item.startedAt, finishedAt: item.finishedAt })),
    billingResources: ledgers.filter(item => item.rangeInstanceId === job.rangeInstanceId && item.cloudWorkspaceId === job.cloudWorkspaceId).map(item => ({
      cloudProvider: item.cloudProvider, cloudAccountUid: item.cloudAccountUid, regionId: item.regionId, cloudResourceId: item.cloudResourceId,
      cloudResourceType: item.cloudResourceType, sourceProvisionJobId: item.sourceProvisionJobId, billingStartAt: item.billingStartAt, releasedAt: item.releasedAt })),
  };
}
