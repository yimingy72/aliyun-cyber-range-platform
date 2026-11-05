import type { BillingLedgerResourceRecord, BillingSourceJob, ProvisionJobStepLogRecord, BillingSourceInstance } from './admin.repository';
import { isIPv4 } from 'node:net';
import { readSingleInstanceCreationRejection } from './single-instance-creation-rejection';

const descriptions: Record<string, string> = {
  node_reset_stop:'Stop the selected node without releasing cloud inventory',node_reset_reinit_intent:'Persist the system-disk-only reset intent',
  node_reset_reinit_receipt:'Record the native disk reset receipt',node_reset_reinit_rejected:'Record an identified cloud rejection',
  node_reset_verify_disk:'Verify original system disk and attachment',node_reset_start:'Restore the selected node power',
  node_reset_dns:'Restore and verify deployed DNS',node_reset_restore_power:'Restore original power state',node_reset_verified:'Verify reset target and preserved resources',
  prepare: 'Prepare the recorded operation', render_template: 'Validate and render the topology before cloud creation', tofu_init: 'Initialize OpenTofu', tofu_apply: 'Apply the recorded topology',
  destroy: 'Destroy the recorded topology', tofu_destroy: 'Destroy the recorded topology', verify_destroy: 'Platform cloud absence verification',
  persist_access_entry: 'Persist cloud resources and billing sources', range_resource_inventory: 'Persist resource identities',
  single_instance_creation_receipt: 'Persist exact provider creation identity',
  platform_billing_origin_repair: 'Restore a verified billing creation source',
  cleanup_failed_create_resources: 'Clean up partial creation',
  confirmed_inventory_absence: 'Verify confirmed physical inventory is absent',
  confirmed_inventory_remaining: 'Preserve confirmed cleanup remaining resources',
  confirmed_inventory_delete_intent: 'Persist exact native cleanup intent',
  confirmed_inventory_delete_receipt: 'Record native cleanup request acknowledgement',
};
const identity = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const maps = ['routeTableIds', 'subnetIds', 'networkAclIds', 'securityGroupIds', 'hostIds', 'systemDiskIds', 'dataDiskIds',
  'unverifiedDiskIds', 'diskInventoryHostIds', 'secondaryNetworkInterfaceIds', 'natGatewayIds', 'snatEntryIds', 'dnatEntryIds', 'eipAllocationIds'];
const resourceKey = (value: string) => identity(value) || value.length <= 1024
  && /^(?:observed:)?module\.range\.(?:alicloud|tencentcloud)_[a-z_]+\.[A-Za-z0-9_]+(?:\[(?:"[A-Za-z0-9][A-Za-z0-9:_-]{0,255}"|\d+)\])?(?:#[1-9]\d*)?$/.test(value);

function resourceIdentity(value: unknown, field: string, provider: unknown) {
  if (identity(value)) return true;
  if (provider !== 'tencent_cloud' || typeof value !== 'string' || value.length > 256) return false;
  // Tencent NAT relation IDs are provider-generated composites, not plain cloud IDs.
  if (field === 'snatEntryIds') return /^nat-[a-z0-9]+#subnet-[a-z0-9]+$/.test(value);
  if (field !== 'dnatEntryIds') return false;
  const match = value.match(/^(TCP|UDP):\/\/vpc-[a-z0-9]+:nat-[a-z0-9]+@([0-9.]+):([1-9]\d{0,4})$/);
  return Boolean(match && isIPv4(match[2]) && Number(match[3]) <= 65535);
}

function resourceIds(value: unknown, provider: unknown, depth = 0): Record<string, unknown> {
  if (!object(value) || depth > 1) throw new Error('Invalid inventory');
  const result: Record<string, unknown> = {};
  for (const field of ['vpcId', 'eipAllocationId']) if (value[field] != null) {
    if (!identity(value[field])) throw new Error('Invalid resource ID');
    result[field] = value[field];
  }
  for (const field of maps) if (value[field] != null) {
    if (!object(value[field]) || Object.keys(value[field]).length > 1000) throw new Error('Invalid resource map');
    const entries = Object.entries(value[field]);
    if (entries.some(([key, id]) => !resourceKey(key)
      && !(provider === 'tencent_cloud' && ['snatEntryIds', 'dnatEntryIds'].includes(field) && key === id && resourceIdentity(key, field, provider))
      || !resourceIdentity(id, field, provider))) throw new Error('Invalid resource identity');
    result[field] = Object.fromEntries(entries);
  }
  if (value.retiredResources != null) result.retiredResources = resourceIds(value.retiredResources, provider, depth + 1);
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
    resources: resourceIds(value.resources, context.provider) };
}

// Deliberately project identities and fixed phase descriptions; raw logs and provider output may contain secrets.
export function buildProvisionJobEvidence(job: BillingSourceJob, steps: ProvisionJobStepLogRecord[], jobs: BillingSourceJob[], ledgers: BillingLedgerResourceRecord[], instance?: BillingSourceInstance | null) {
  const scopedSteps = steps.filter(step => step.jobId === job.id && step.cloudWorkspaceId === job.cloudWorkspaceId);
  const inventories: ReturnType<typeof inventory>[] = [];
  let invalidInventoryCount = 0;
  for (const step of scopedSteps.filter(step => ['range_resource_inventory', 'single_instance_creation_receipt'].includes(step.stepName) && step.status === 'succeeded')) {
    try { inventories.push(inventory(step, job.rangeInstanceId)); } catch { invalidInventoryCount++; }
  }
  const ownLedgers = ledgers.filter(item => item.rangeInstanceId === job.rangeInstanceId && item.cloudWorkspaceId === job.cloudWorkspaceId);
  const nativeIds = new Set(ownLedgers.map(item => item.cloudResourceId));
  const destroyCommands = scopedSteps.filter(step => ['destroy', 'tofu_destroy'].includes(step.stepName) && step.finishedAt
    && (job.jobType === 'destroy' || job.topologySnapshot?.operation === 'destroy')).map(step => {
    const output = typeof step.stdoutExcerpt === 'string' && step.stdoutExcerpt.length <= 64_000 ? step.stdoutExcerpt : '';
    const started = new Map<string, string>(), completedResourceIds = new Set<string>(), completedAddresses = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const start = /^(module\.range\.alicloud_[a-z_]+\.[A-Za-z0-9_]+(?:\["[A-Za-z0-9:_-]+"\])?): Destroying\.\.\. \[id=((?:i|d|eip|ngw)-[a-z0-9]+)\]$/.exec(line.trim());
      if (start && nativeIds.has(start[2])) started.set(start[1], start[2]);
      const end = /^(module\.range\.alicloud_[a-z_]+\.[A-Za-z0-9_]+(?:\["[A-Za-z0-9:_-]+"\])?): Destruction complete after [0-9.hms]+$/.exec(line.trim());
      if (end) { completedAddresses.add(end[1]); if (started.has(end[1])) completedResourceIds.add(started.get(end[1])!); }
    }
    const summary = /^Destroy complete! Resources: (\d{1,6}) destroyed\.$/m.exec(output);
    return { stepName: step.stepName, status: step.status, completedBy: step.finishedAt,
      coverage: 'recorded_opentofu_output' as const, commandReportedComplete: step.status === 'succeeded' && Boolean(summary),
      reportedDestroyedCount: summary ? Number(summary[1]) : null, completedResourceIds: [...completedResourceIds], completedAddresses: [...completedAddresses] };
  });
  const submitted = job.topologySnapshot?.compiledProvisionSpec?.eips;
  const eipAllocationIntents = Array.isArray(submitted) ? inventories.flatMap(item => {
    const ids = item.resources.eipAllocationIds;
    if (!object(ids)) return [];
    return submitted.flatMap(value => {
      if (!object(value) || !identity(value.key) || !['nat_gateway', 'ecs'].includes(String(value.bindTargetType)) || !identity(value.bindTargetKey)
        || !Number.isInteger(value.bandwidthMbps) || Number(value.bandwidthMbps) <= 0 || Number(value.bandwidthMbps) > 100_000) return [];
      const id = ids[String(value.key)];
      if (typeof id !== 'string' || !ownLedgers.some(row => row.cloudResourceId === id && row.sourceProvisionJobId === job.id)) return [];
      return [{ cloudResourceId: id, key: value.key, bindTargetType: value.bindTargetType, bindTargetKey: value.bindTargetKey, bandwidthMbps: value.bandwidthMbps }];
    });
  }) : [];
  const creationRejections = scopedSteps.map(step => readSingleInstanceCreationRejection(instance, job, step, jobs)).filter(value => value !== null);
  return { coverage: 'platform_recorded_job_evidence' as const, inventories, invalidInventoryCount, destroyCommands, eipAllocationIntents, creationRejections,
    steps: scopedSteps.filter(step => Object.prototype.hasOwnProperty.call(descriptions, step.stepName)).map(step => ({
      stepName: step.stepName, status: step.status, description: descriptions[step.stepName], startedAt: step.startedAt, finishedAt: step.finishedAt })),
    relatedJobs: jobs.filter(item => item.rangeInstanceId === job.rangeInstanceId && item.cloudWorkspaceId === job.cloudWorkspaceId).map(item => ({
      id: item.id, jobType: item.jobType, status: item.status, createdAt: item.createdAt, startedAt: item.startedAt, finishedAt: item.finishedAt })),
    billingResources: ownLedgers.map(item => ({
      cloudProvider: item.cloudProvider, cloudAccountUid: item.cloudAccountUid, regionId: item.regionId, cloudResourceId: item.cloudResourceId,
      cloudResourceType: item.cloudResourceType, sourceProvisionJobId: item.sourceProvisionJobId, billingStartAt: item.billingStartAt, releasedAt: item.releasedAt })),
  };
}
