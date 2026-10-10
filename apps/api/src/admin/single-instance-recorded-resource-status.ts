import { BadGatewayException, ConflictException } from '@nestjs/common';
import type { AdminRepository, BillingLedgerResourceRecord, BillingLedgerResourceType, RangeInstanceRecord, RangeResourceSummary } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';
import { assertTencentAccount, describeTencentKnownResourcesWithEvidence, type TencentResourceEvidence } from './tencent-cloud-resources';

const kinds = { ecs: ['ecs','ins'], disk: ['disk','disk'], eip: ['eip','eip'], nat_gateway: ['nat','nat'] } as const;
type SupportedType = keyof typeof kinds;
type RecordedResource = { cloudResourceType: SupportedType; cloudResourceId: string; sources: Array<'inventory' | 'ledger'>; ledgerIds: string[]; exists: boolean };
function fail(): never { throw new ConflictException('Recorded cloud resource evidence differs from its frozen instance ownership or account'); }
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, any>; }
function identity(value: unknown, type: SupportedType): string { if (typeof value !== 'string' || !new RegExp(`^${kinds[type][1]}-[A-Za-z0-9]+$`).test(value)) fail(); return value; }
function sameWorkspace(a: { cloudWorkspaceId?: string }, b: { cloudWorkspaceId?: string }) { return (a.cloudWorkspaceId ?? 'legacy-unbound') === (b.cloudWorkspaceId ?? 'legacy-unbound'); }

export async function readTencentSingleRecordedResourceStatus(instance: RangeInstanceRecord, account: SystemCloudAccountContext, repository: AdminRepository) {
  assertTencentAccount(account);
  const config = instance.singleInstanceConfig;
  if (instance.instanceMode !== 'single' || instance.cloudProvider !== 'tencent_cloud' || !config || config.executionBackend !== 'opentofu'
    || config.cloudAccountContextId !== account.cloudAccountContextId || config.cloudAccountUid !== account.accountUid
    || config.regionId !== account.defaultRegion || config.zoneId !== account.defaultZoneId) fail();
  const contextMatches = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const context = value as Record<string, unknown>;
    return context.provider === 'tencent_cloud' && context.cloudAccountContextId === config.cloudAccountContextId
      && context.cloudAccountUid === config.cloudAccountUid && context.regionId === config.regionId && context.zoneId === config.zoneId;
  };
  const rows = await repository.listBillingLedgerResources({ rangeInstanceId: instance.id });
  for (const row of rows) {
    if (!sameWorkspace(row, instance) || row.rangeInstanceId !== instance.id || row.cloudProvider !== instance.cloudProvider
      || row.cloudAccountUid !== config.cloudAccountUid || row.regionId !== config.regionId || row.ownerUserId !== instance.ownerUserId
      || row.singleInstanceBatchId !== (instance.singleInstanceBatchId ?? null) || row.billingScope !== (instance.ownerUserId ? 'user' : 'platform')) fail();
    for (const [key, expected] of Object.entries({ CloudAccountContextId: config.cloudAccountContextId, CloudAccountUid: config.cloudAccountUid, RangeInstanceId: instance.id })) {
      if (row.tagsSnapshot[key] !== undefined && row.tagsSnapshot[key] !== expected) fail();
    }
  }
  const resources = new Map<string, RecordedResource>(), unverifiedDisks = new Set<string>();
  const add = (type: SupportedType, value: unknown, source: 'inventory' | 'ledger', ledgerId?: string) => {
    const id = identity(value, type), key = `${type}:${id}`;
    const record = resources.get(key) ?? { cloudResourceType: type, cloudResourceId: id, sources: [], ledgerIds: [], exists: false };
    if (!record.sources.includes(source)) record.sources.push(source);
    if (ledgerId && !record.ledgerIds.includes(ledgerId)) record.ledgerIds.push(ledgerId);
    resources.set(key, record);
  };
  const seen = new Set<RangeResourceSummary>();
  const inventory = (summary: RangeResourceSummary | null | undefined, depth = 0) => {
    if (!summary) return;
    if (seen.has(summary) || depth > 8 || !contextMatches(summary.executionContext)) fail(); seen.add(summary);
    const map = (value: unknown, type: SupportedType) => value == null ? [] : Object.values(object(value)).map(id => identity(id, type));
    const unverified = map(summary.unverifiedDiskIds, 'disk'); for (const id of unverified) unverifiedDisks.add(id);
    for (const id of map(summary.hostIds, 'ecs')) add('ecs', id, 'inventory');
    for (const id of [...map(summary.systemDiskIds, 'disk'), ...map(summary.dataDiskIds, 'disk')]) if (!unverified.includes(id)) add('disk', id, 'inventory');
    for (const id of map(summary.eipAllocationIds, 'eip')) add('eip', id, 'inventory');
    if (summary.eipAllocationId) add('eip', summary.eipAllocationId, 'inventory');
    for (const id of map(summary.natGatewayIds, 'nat_gateway')) add('nat_gateway', id, 'inventory');
    inventory(summary.retiredResources, depth + 1);
  };
  inventory(instance.resourceSummary);
  const jobs = new Map<string, Awaited<ReturnType<AdminRepository['getProvisionJobById']>>>();
  const logs = new Map<string, Awaited<ReturnType<AdminRepository['listProvisionJobStepLogs']>>>();
  const proveLedgerContext = async (row: BillingLedgerResourceRecord) => {
    if (resources.has(`${row.cloudResourceType}:${row.cloudResourceId}`)) return;
    if (!row.sourceProvisionJobId) fail();
    if (!jobs.has(row.sourceProvisionJobId)) jobs.set(row.sourceProvisionJobId, await repository.getProvisionJobById(row.sourceProvisionJobId));
    const job = jobs.get(row.sourceProvisionJobId);
    if (!job || !sameWorkspace(job, instance) || job.rangeInstanceId !== instance.id || !['create','retry','update'].includes(job.jobType)) fail();
    if (!logs.has(job.id)) logs.set(job.id, await repository.listProvisionJobStepLogs(job.id));
    const proven = logs.get(job.id)!.some(log => {
      if (!sameWorkspace(log, instance) || log.jobId !== job.id || log.stepName !== 'platform_billing_creation_inventory' || log.status !== 'succeeded' || !log.message) return false;
      let proof: Record<string, any>; try { proof = object(JSON.parse(log.message)); } catch { return false; }
      return proof.version === 1 && proof.cloudProvider === 'tencent_cloud' && proof.cloudWorkspaceId === (instance.cloudWorkspaceId ?? 'legacy-unbound')
        && proof.sourceJobId === job.id && proof.rangeInstanceId === instance.id && proof.ownerUserId === instance.ownerUserId
        && contextMatches(proof.executionContext) && Array.isArray(proof.resources)
        && proof.resources.some((entry: any) => entry?.cloudResourceType === row.cloudResourceType && entry.cloudResourceId === row.cloudResourceId);
    });
    if (!proven) fail();
  };
  const unsupportedLedgerResourceTypes = [...new Set(rows.filter(row => !(row.cloudResourceType in kinds)).map(row => row.cloudResourceType))];
  for (const row of rows) {
    if (!(row.cloudResourceType in kinds)) continue;
    identity(row.cloudResourceId, row.cloudResourceType as SupportedType);
    await proveLedgerContext(row); add(row.cloudResourceType as SupportedType, row.cloudResourceId, 'ledger', row.id);
  }
  const excludedUnverifiedDiskIds = [...unverifiedDisks].filter(id => !resources.has(`disk:${id}`));
  const evidence: TencentResourceEvidence[] = [];
  try {
    for (const type of Object.keys(kinds) as SupportedType[]) {
      const ids = [...resources.values()].filter(row => row.cloudResourceType === type).map(row => row.cloudResourceId);
      if (!ids.length) continue;
      const result = await describeTencentKnownResourcesWithEvidence(account, kinds[type][0], ids);
      evidence.push(...result.evidence);
      for (const observed of result.resources) resources.get(`${type}:${observed.id}`)!.exists = true;
    }
  } catch { throw new BadGatewayException('Recorded cloud resource query failed or returned incomplete evidence; absence is unverified'); }
  const checked = [...resources.values()];
  return { provider: 'tencent_cloud' as const, cloudAccountContextId: config.cloudAccountContextId!, cloudAccountUid: config.cloudAccountUid!, regionId: config.regionId!,
    checkedAt: new Date().toISOString(), coverage: 'persisted_instance_compute_resource_ids' as const,
    allKnownAbsent: checked.length && !excludedUnverifiedDiskIds.length && !unsupportedLedgerResourceTypes.length ? checked.every(row => !row.exists) : null,
    resources: checked, evidence, excludedUnverifiedDiskIds, unsupportedLedgerResourceTypes: unsupportedLedgerResourceTypes as BillingLedgerResourceType[] };
}
