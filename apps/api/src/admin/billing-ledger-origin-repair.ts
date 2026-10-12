import { createHash } from 'node:crypto';
import type { AdminRepository } from './admin.repository';
import { billRegionConflict, billRegionId, classifyPlatformBillLine, isAlibabaBillingPayload, ledgerBillingDateMatches, type PlatformBillingProof } from './billing-platform-scope';
import { parseAliyunBillingTags } from './billing-tagging';
import { billingDayText } from './billing-window';
import { BillingDecimal, isSupportedBillingAmount } from './billing-amount';

function validAmount(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value))) return false;
  return isSupportedBillingAmount(new BillingDecimal(value));
}

// Official tags corroborate an existing physical ledger and a frozen platform request; they never create ownership.
export async function repairAlibabaLedgerOrigins(repository: AdminRepository, proof: PlatformBillingProof,
  items: Record<string, unknown>[], cloudAccountUid: string, billingDate: string) {
  const candidates = proof.ledgers.filter(ledger => ledger.cloudProvider === 'alibaba_cloud' && ledger.cloudResourceType === 'ecs'
    && ledger.cloudAccountUid === cloudAccountUid && !ledger.sourceProvisionJobId && ledger.rangeInstanceId);
  if (!candidates.length) return false;
  const [instances, jobs] = await Promise.all([repository.listRangeInstances(), repository.listProvisionJobs()]);
  let refreshProof = false;
  for (const ledger of candidates) {
    const instance = instances.find(value => value.id === ledger.rangeInstanceId);
    const config = instance?.singleInstanceConfig;
    const namespace = ledger.cloudWorkspaceId ?? 'legacy-unbound';
    if (!instance || instance.cloudProvider !== 'alibaba_cloud' || instance.instanceMode !== 'single' || config?.executionBackend !== 'opentofu'
      || (instance.cloudWorkspaceId ?? 'legacy-unbound') !== namespace || !config.cloudAccountContextId || config.cloudAccountUid !== cloudAccountUid
      || config.regionId !== ledger.regionId || !config.zoneId?.startsWith(`${ledger.regionId}-`) || !config.hostKey
      || ledger.ownerUserId !== (instance.ownerUserId ?? null) || ledger.billingScope !== (instance.ownerUserId ? 'user' : 'platform')
      || !instance.singleInstanceBatchId || ledger.singleInstanceBatchId !== instance.singleInstanceBatchId
      || billingDayText(ledger.billingStartAt) !== billingDayText(instance.createdAt) || !ledgerBillingDateMatches(ledger, billingDate)) continue;
    const rows = items.filter(line => isAlibabaBillingPayload(line) && classifyPlatformBillLine(line).kind === 'direct'
      && line.ProductCode === 'ecs' && line.InstanceID === ledger.cloudResourceId && String(line.OwnerID) === cloudAccountUid
      && String(line.BillAccountID) === cloudAccountUid && line.BillingDate === billingDate);
    if (!rows.length) continue;
    const sources = new Set<string>();
    let valid = true;
    for (const line of rows) {
      const tags = parseAliyunBillingTags(line.Tag);
      const keys = typeof line.Tag === 'string' ? [...line.Tag.matchAll(/(?:^|;)\s*key:([^;]+?)\s+value:([^;]*)/gi)].map(match => match[1].trim()) : [];
      const expected = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', PlatformTagVersion: '1', PlatformResourceType: 'ecs',
        CloudAccountUid: cloudAccountUid, CloudAccountContextId: config.cloudAccountContextId, ExecutionBackend: 'opentofu',
        RangeInstanceId: instance.id, SingleInstanceBatchId: instance.singleInstanceBatchId, PlatformHostKey: config.hostKey,
        PlatformScope: ledger.billingScope, BillingStartAt: billingDayText(ledger.billingStartAt), ...(instance.ownerUserId ? { PlatformUserId: instance.ownerUserId } : {}) };
      const job = jobs.find(value => value.id === tags.PlatformCreateJobId);
      if (new Set(keys).size !== keys.length || Object.entries(expected).some(([key, value]) => tags[key] !== value)
        || (tags.PlatformUserId ?? '') !== (instance.ownerUserId ?? '') || tags.CloudProvider && tags.CloudProvider !== 'alibaba_cloud'
        || !validAmount(line.PretaxAmount)
        || !job || !['create', 'retry'].includes(job.jobType) || job.rangeInstanceId !== instance.id
        || (job.cloudWorkspaceId ?? 'legacy-unbound') !== namespace || job.createdAt > ledger.createdAt
        || config.opentofuCreateJobId && config.opentofuCreateJobId !== job.id
        || billRegionConflict(line) || billRegionId(line) && billRegionId(line) !== ledger.regionId || line.Zone !== config.zoneId) { valid = false; break; }
      sources.add(job.id);
    }
    if (!valid || sources.size !== 1) continue;
    const sourceProvisionJobId = [...sources][0];
    const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    // Commit the missing link and its audit together, without overwriting a competing writer or release state.
    await repository.repairBillingLedgerOrigin({ expected: ledger, sourceProvisionJobId,
      auditMessage: JSON.stringify({ version: 1, cloudProvider: 'alibaba_cloud', cloudWorkspaceId: namespace, cloudAccountUid,
        regionId: ledger.regionId, cloudAccountContextId: config.cloudAccountContextId, rangeInstanceId: instance.id,
        singleInstanceBatchId: instance.singleInstanceBatchId, ownerUserId: instance.ownerUserId ?? null,
        ledgerId: ledger.id, cloudResourceId: ledger.cloudResourceId, sourceProvisionJobId, billingDate, officialRowsFingerprint: fingerprint,
        evidence: 'official_bill_existing_physical_ledger_frozen_single_request' }) });
    // A competing worker may already have supplied a valid source; bill matching must read that committed version too.
    refreshProof = true;
  }
  return refreshProof;
}
