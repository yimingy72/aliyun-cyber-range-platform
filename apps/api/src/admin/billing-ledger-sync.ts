import type {
  AdminRepository,
  BillingLedgerResourceType,
  BillingScope,
  ProvisionJobRecord,
  RangeInstanceRecord,
  RangeResourceSummary,
} from './admin.repository';

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

  for (const diskId of collectResourceIds(resourceSummary.systemDiskIds)) {
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

export async function syncRangeInstanceBillingLedger(input: SyncRangeInstanceBillingLedgerInput) {
  const billingScope = resolveBillingScope(input.instance);
  const ledgerSpecs = buildLedgerSpecs(input.resourceSummary);
  const hostIds = collectResourceIds(input.resourceSummary?.hostIds);
  const systemDiskIds = new Set(collectResourceIds(input.resourceSummary?.systemDiskIds));
  const existingLedgers = await input.repository.listBillingLedgerResources();
  const instanceSourceJobIds = [
    ...new Set(
      existingLedgers
        .filter((ledger) => ledger.rangeInstanceId === input.instance.id)
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
      await input.repository.updateBillingLedgerResource(legacyDiskLedger.id, {
        releasedAt: input.billingStartAt,
      });
    }
  }

  for (const spec of ledgerSpecs) {
    const existing = await input.repository.findBillingLedgerResource({
      cloudProvider: input.instance.cloudProvider,
      regionId: input.regionId,
      cloudResourceId: spec.cloudResourceId,
      cloudResourceType: spec.cloudResourceType,
    });

    if (existing) {
      const existingSourceJob = existing.sourceProvisionJobId
        ? sourceJobs.find(([jobId]) => jobId === existing.sourceProvisionJobId)?.[1] ??
          (await input.repository.getProvisionJobById(existing.sourceProvisionJobId))
        : null;

      await input.repository.updateBillingLedgerResource(existing.id, {
        billingScope,
        ownerUserId: input.instance.ownerUserId ?? null,
        rangeInstanceId: input.instance.id,
        singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
        sourceProvisionJobId: isSuccessfulLaunchJob(existingSourceJob) ? existingSourceJob.id : sourceProvisionJobId,
        releasedAt: null,
      });
      continue;
    }

    await input.repository.createBillingLedgerResource({
      cloudProvider: input.instance.cloudProvider,
      cloudAccountUid: input.cloudAccountUid ?? null,
      regionId: input.regionId,
      cloudResourceId: spec.cloudResourceId,
      cloudResourceType: spec.cloudResourceType,
      billingScope,
      ownerUserId: input.instance.ownerUserId ?? null,
      rangeInstanceId: input.instance.id,
      singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
      sourceProvisionJobId,
      billingStartAt: input.billingStartAt,
      tagsSnapshot: {},
    });
  }
}

export async function releaseRangeInstanceBillingLedger(
  repository: AdminRepository,
  rangeInstanceId: string,
  releasedAt: Date,
) {
  // ponytail: O(n) scan over ledger rows; add a repository query by rangeInstanceId if billing volume makes this expensive.
  const resources = await repository.listBillingLedgerResources();

  await Promise.all(
    resources
      .filter((item) => item.rangeInstanceId === rangeInstanceId && item.releasedAt === null)
      .map((item) =>
        repository.updateBillingLedgerResource(item.id, {
          releasedAt,
        }),
      ),
  );
}
