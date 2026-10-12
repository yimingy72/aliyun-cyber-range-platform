import type { PlatformBillingProof } from './billing-platform-scope';

export function readPlatformBillingStartedAt(): Date | null {
  const value = process.env.PLATFORM_BILLING_STARTED_AT?.trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('PLATFORM_BILLING_STARTED_AT must be a fixed ISO timestamp with a timezone');
  }
  return new Date(value);
}

export function currentBillingSyncBatchId(base: string, startedAt: Date | null) {
  return startedAt ? `billing-current:${startedAt.toISOString()}:${base}` : base;
}

export function currentBillingRows<T extends { syncBatchId: string }>(rows: T[], startedAt: Date | null): T[] {
  return startedAt ? rows.filter(row => row.syncBatchId.startsWith(`billing-current:${startedAt.toISOString()}:`)) : rows;
}

// Creation proof must be checked in full before removing historical parents of new resources.
export function currentPlatformBillingProof(proof: PlatformBillingProof, startedAt: Date | null): PlatformBillingProof {
  if (!startedAt) return proof;
  const ledgers = proof.ledgers.flatMap(ledger => {
    const job = proof.creationJobs?.get(ledger.id);
    // A retry can create a new physical resource under an older platform instance.
    // A later observation/recovery job cannot turn a pre-existing resource into a new one.
    const birth = job?.startedAt ?? job?.createdAt;
    const verifiedBirth = job && birth && ['create', 'retry', 'update'].includes(job.jobType)
      && job.rangeInstanceId === ledger.rangeInstanceId
      && (job.cloudWorkspaceId ?? 'legacy-unbound') === (ledger.cloudWorkspaceId ?? 'legacy-unbound')
      && job.createdAt <= ledger.createdAt && birth <= ledger.createdAt ? birth : null;
    const billingStartAt = verifiedBirth && verifiedBirth > ledger.billingStartAt ? verifiedBirth : ledger.billingStartAt;
    return billingStartAt >= startedAt ? [{ ...ledger, billingStartAt }] : [];
  });
  const ids = new Set(ledgers.map(ledger => ledger.id));
  return { ...proof, ledgers, snapshotParentProof: proof,
    imageImports: proof.imageImports.filter(job => (job.uploadCompletedAt ?? job.createdAt) >= startedAt),
    packedImages: proof.packedImages.filter(artifact => artifact.createdAt >= startedAt),
    createdLedgerIds: new Set([...proof.createdLedgerIds].filter(id => ids.has(id))),
    unverifiedSourceLedgerIds: new Set([...proof.unverifiedSourceLedgerIds].filter(id => ids.has(id))),
  };
}
