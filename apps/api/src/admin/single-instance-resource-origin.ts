import type { AdminRepository, RangeInstanceRecord } from './admin.repository';

const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Cloud tags only locate candidates. Read these independent, already persisted
// identities before a candidate can be written into a summary or billing ledger.
export async function readProvenSingleInstanceIds(repository: AdminRepository, instance: RangeInstanceRecord) {
  const config = instance.singleInstanceConfig;
  const sourceId = config?.opentofuCreateJobId ?? config?.nativeCreateJobId;
  const source = sourceId ? await repository.getProvisionJobById(sourceId) : null;
  if (instance.instanceMode !== 'single' || !config || config.executionBackend === 'opentofu' && !instance.singleInstanceBatchId
    || !config.cloudAccountContextId || !config.cloudAccountUid || !config.regionId || !source?.startedAt
    || source.rangeInstanceId !== instance.id || !['create', 'retry'].includes(source.jobType)
    || source.jobType === 'retry' && source.topologySnapshot?.operation === 'destroy'
    || (source.cloudWorkspaceId ?? 'legacy-unbound') !== (instance.cloudWorkspaceId ?? 'legacy-unbound')) {
    throw new Error('Emergency cleanup ownership requires the original frozen creation job and workspace');
  }
  const validId = (id: unknown): id is string => typeof id === 'string'
    && (instance.cloudProvider === 'tencent_cloud' ? /^ins-[a-z0-9]+$/ : /^i-[A-Za-z0-9-]{1,125}$/).test(id);
  const proven = new Set<string>();
  const contextMatches = (context: any) => object(context) && context.provider === instance.cloudProvider
    && context.cloudAccountContextId === config.cloudAccountContextId && context.cloudAccountUid === config.cloudAccountUid
    && context.regionId === config.regionId && context.zoneId === config.zoneId;
  if (contextMatches(instance.resourceSummary?.executionContext)
    || config.executionBackend !== 'opentofu' && config.nativeCreateJobId === source.id && instance.resourceSummary?.mode === 'ecs-native') {
    for (const id of Object.values(instance.resourceSummary?.hostIds ?? {})) if (validId(id)) proven.add(id);
  }
  for (const row of await repository.listBillingLedgerResources({ rangeInstanceId: instance.id })) {
    if (row.cloudProvider === instance.cloudProvider && row.cloudAccountUid === config.cloudAccountUid && row.regionId === config.regionId
      && row.rangeInstanceId === instance.id && row.singleInstanceBatchId === instance.singleInstanceBatchId
      && row.ownerUserId === instance.ownerUserId && row.sourceProvisionJobId === source.id && row.cloudResourceType === 'ecs'
      && (row.cloudWorkspaceId ?? 'legacy-unbound') === (instance.cloudWorkspaceId ?? 'legacy-unbound') && validId(row.cloudResourceId)) proven.add(row.cloudResourceId);
  }
  for (const log of await repository.listProvisionJobStepLogs(source.id)) {
    if (log.jobId !== source.id || log.status !== 'succeeded' || !['range_resource_inventory', 'platform_billing_creation_inventory', 'single_instance_creation_receipt'].includes(log.stepName)
      || !log.message || log.message.length > 1024 * 1024
      || (log.cloudWorkspaceId ?? 'legacy-unbound') !== (instance.cloudWorkspaceId ?? 'legacy-unbound')) continue;
    let evidence: any;
    try { evidence = JSON.parse(log.message); } catch { continue; }
    if (!object(evidence) || evidence.version !== 1 || evidence.cloudProvider !== instance.cloudProvider
      || evidence.rangeInstanceId !== instance.id || evidence.sourceJobId !== source.id || evidence.ownerUserId !== instance.ownerUserId
      || (evidence.cloudWorkspaceId ?? 'legacy-unbound') !== (instance.cloudWorkspaceId ?? 'legacy-unbound')
      || !contextMatches(evidence.executionContext)) continue;
    const ids = Array.isArray(evidence.resources) ? evidence.resources.filter((row: any) => object(row) && row.cloudResourceType === 'ecs').map((row: any) => row.cloudResourceId)
      : object(evidence.resources?.hostIds) ? Object.values(evidence.resources.hostIds) : [];
    for (const id of ids) if (validId(id)) proven.add(id);
  }
  return proven;
}
