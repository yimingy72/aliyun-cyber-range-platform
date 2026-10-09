import type {
  AdminRepository,
  BillingLedgerResourceType,
  BillingLedgerResourceRecord,
  BillingScope,
  ProvisionJobRecord,
  RangeInstanceRecord,
  RangeResourceSummary,
} from './admin.repository';
import { inventoryDiskIds } from './instance-disk-inventory';

type SyncRangeInstanceBillingLedgerInput = {
  repository: AdminRepository;
  instance: RangeInstanceRecord;
  regionId: string;
  cloudAccountUid?: string | null;
  resourceSummary: RangeResourceSummary | null;
  sourceProvisionJobId?: string | null;
  billingStartAt: Date;
};

type LedgerSpec = {
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
};

function normalizeResourceId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function collectResourceIds(values: Record<string, string> | null | undefined) {
  return [...new Set(Object.values(values ?? {}).map(normalizeResourceId).filter((value): value is string => Boolean(value)))];
}

function resolveBillingScope(instance: RangeInstanceRecord): BillingScope {
  return instance.ownerUserId ? 'user' : 'platform';
}

function isSuccessfulLaunchJob(job: ProvisionJobRecord | null): job is ProvisionJobRecord {
  return job?.status === 'succeeded' && (job.jobType === 'create' || job.jobType === 'retry');
}

function buildLedgerSpecs(resourceSummary: RangeResourceSummary | null): LedgerSpec[] {
  if (!resourceSummary) {
    return [];
  }

  const specs: LedgerSpec[] = [];
  const hostIds = collectResourceIds(resourceSummary.hostIds);

  for (const hostId of hostIds) {
    specs.push({ cloudResourceId: hostId, cloudResourceType: 'ecs' });
  }

  for (const diskId of inventoryDiskIds(resourceSummary)) {
    specs.push({ cloudResourceId: diskId, cloudResourceType: 'disk' });
  }

  const eipIds = [
    ...collectResourceIds(resourceSummary.eipAllocationIds),
    ...(normalizeResourceId(resourceSummary.eipAllocationId) ? [normalizeResourceId(resourceSummary.eipAllocationId)!] : []),
  ];

  for (const eipId of new Set(eipIds)) {
    specs.push({ cloudResourceId: eipId, cloudResourceType: 'eip' });
  }

  for (const natGatewayId of collectResourceIds(resourceSummary.natGatewayIds)) {
    specs.push({ cloudResourceId: natGatewayId, cloudResourceType: 'nat_gateway' });
  }

  for (const snatEntryId of collectResourceIds(resourceSummary.snatEntryIds)) {
    specs.push({ cloudResourceId: snatEntryId, cloudResourceType: 'snat_entry' });
  }

  for (const dnatEntryId of collectResourceIds(resourceSummary.dnatEntryIds)) {
    specs.push({ cloudResourceId: dnatEntryId, cloudResourceType: 'dnat_entry' });
  }

  return specs;
}

function assertLedgerOwnership(ledger: BillingLedgerResourceRecord, input: SyncRangeInstanceBillingLedgerInput) {
  // The legacy unique key excludes account UID; never transfer a colliding resource's billing history.
  if ((ledger.cloudAccountUid && input.cloudAccountUid && ledger.cloudAccountUid !== input.cloudAccountUid)
    || (ledger.ownerUserId && ledger.ownerUserId !== (input.instance.ownerUserId ?? null))
    || (ledger.rangeInstanceId && ledger.rangeInstanceId !== input.instance.id)
    || (ledger.singleInstanceBatchId && ledger.singleInstanceBatchId !== (input.instance.singleInstanceBatchId ?? null))) {
    throw new Error('Billing ledger resource ownership conflicts with the provisioning instance');
  }
}

export async function syncRangeInstanceBillingLedger(input: SyncRangeInstanceBillingLedgerInput) {
  const billingScope = resolveBillingScope(input.instance);
  const ledgerSpecs = buildLedgerSpecs(input.resourceSummary);
  const hostIds = collectResourceIds(input.resourceSummary?.hostIds);
  const systemDiskIds = new Set(collectResourceIds(input.resourceSummary?.systemDiskIds));
  const existingLedgers = await input.repository.listBillingLedgerResources({ rangeInstanceId: input.instance.id });
  const instanceSourceJobIds = [
    ...new Set(
      existingLedgers
        .filter((ledger) => ledger.rangeInstanceId === input.instance.id
          && ledger.cloudProvider === input.instance.cloudProvider && ledger.regionId === input.regionId
          && (!input.cloudAccountUid || !ledger.cloudAccountUid || ledger.cloudAccountUid === input.cloudAccountUid)
          && ledger.ownerUserId === (input.instance.ownerUserId ?? null))
        .flatMap((ledger) => (ledger.sourceProvisionJobId ? [ledger.sourceProvisionJobId] : [])),
    ),
  ];
  const sourceJobs = await Promise.all(
    instanceSourceJobIds.map(async (jobId) => [jobId, await input.repository.getProvisionJobById(jobId)] as const),
  );
  const sourceProvisionJobId =
    sourceJobs.find(([, job]) => isSuccessfulLaunchJob(job))?.[0] ?? input.sourceProvisionJobId ?? null;

  for (const hostId of hostIds) {
    if (systemDiskIds.has(hostId)) {
      continue;
    }

    const legacyDiskLedger = await input.repository.findBillingLedgerResource({
      cloudProvider: input.instance.cloudProvider,
      regionId: input.regionId,
      cloudResourceId: hostId,
      cloudResourceType: 'disk',
    });

    if (legacyDiskLedger && legacyDiskLedger.rangeInstanceId === input.instance.id && !legacyDiskLedger.releasedAt) {
      assertLedgerOwnership(legacyDiskLedger, input);
      await input.repository.updateBillingLedgerResource(legacyDiskLedger.id, {
        releasedAt: input.billingStartAt,
      });
    }
  }

  for (const spec of ledgerSpecs) {
    const key = {
      cloudProvider: input.instance.cloudProvider,
      regionId: input.regionId,
      cloudResourceId: spec.cloudResourceId,
      cloudResourceType: spec.cloudResourceType,
    };
    let existing = await input.repository.findBillingLedgerResource(key);

    if (!existing) {
      try {
        await input.repository.createBillingLedgerResource({
          ...key,
          cloudAccountUid: input.cloudAccountUid ?? null,
          billingScope,
          ownerUserId: input.instance.ownerUserId ?? null,
          rangeInstanceId: input.instance.id,
          singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
          sourceProvisionJobId,
          billingStartAt: input.billingStartAt,
          tagsSnapshot: {},
        });
        continue;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
        existing = await input.repository.findBillingLedgerResource(key);
        if (!existing) throw error;
      }
    }

    assertLedgerOwnership(existing, input);
    const backfillUid = !existing.cloudAccountUid && input.cloudAccountUid;
    if (backfillUid && (existing.rangeInstanceId !== input.instance.id
      || existing.ownerUserId !== (input.instance.ownerUserId ?? null)
      || existing.singleInstanceBatchId !== (input.instance.singleInstanceBatchId ?? null)
      || existing.billingScope !== billingScope)) {
      throw new Error('Billing ledger account backfill requires the same proven instance ownership');
    }
    const existingSourceJob = existing.sourceProvisionJobId
      ? sourceJobs.find(([jobId]) => jobId === existing.sourceProvisionJobId)?.[1] ??
        (await input.repository.getProvisionJobById(existing.sourceProvisionJobId))
      : null;

    await input.repository.updateBillingLedgerResource(existing.id, {
      ...(backfillUid ? { cloudAccountUid: backfillUid } : {}),
      billingScope,
      ownerUserId: input.instance.ownerUserId ?? null,
      rangeInstanceId: input.instance.id,
      singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
      sourceProvisionJobId: isSuccessfulLaunchJob(existingSourceJob) ? existingSourceJob.id : sourceProvisionJobId,
      releasedAt: null,
    });
  }
}

export async function releaseRangeInstanceBillingLedger(
  repository: AdminRepository,
  rangeInstanceId: string,
  releasedAt: Date,
) {
  const resources = await repository.listBillingLedgerResources({ rangeInstanceId });

  await Promise.all(
    resources
      .filter((item) => item.rangeInstanceId === rangeInstanceId && item.releasedAt === null
        && item.cloudResourceType !== 'image' && item.cloudResourceType !== 'snapshot')
      .map((item) =>
        repository.updateBillingLedgerResource(item.id, {
          releasedAt,
        }),
      ),
  );
}
