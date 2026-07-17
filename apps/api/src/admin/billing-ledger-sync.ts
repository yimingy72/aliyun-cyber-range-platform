import type {
  AdminRepository,
  BillingLedgerResourceType,
  BillingScope,
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

function buildLedgerSpecs(resourceSummary: RangeResourceSummary | null): LedgerSpec[] {
  if (!resourceSummary) {
    return [];
  }

  const specs: LedgerSpec[] = [];
  const hostIds = collectResourceIds(resourceSummary.hostIds);

  for (const hostId of hostIds) {
    specs.push({ cloudResourceId: hostId, cloudResourceType: 'ecs' });
    specs.push({ cloudResourceId: hostId, cloudResourceType: 'disk' });
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

  for (const spec of ledgerSpecs) {
    const existing = await input.repository.findBillingLedgerResource({
      cloudProvider: input.instance.cloudProvider,
      regionId: input.regionId,
      cloudResourceId: spec.cloudResourceId,
      cloudResourceType: spec.cloudResourceType,
    });

    if (existing) {
      await input.repository.updateBillingLedgerResource(existing.id, {
        billingScope,
        ownerUserId: input.instance.ownerUserId ?? null,
        rangeInstanceId: input.instance.id,
        singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
        sourceProvisionJobId: input.sourceProvisionJobId ?? null,
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
      sourceProvisionJobId: input.sourceProvisionJobId ?? null,
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
