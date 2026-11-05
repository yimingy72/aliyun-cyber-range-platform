import type { BillingLedgerResourceRecord } from './admin.repository';

// Expense responsibility is independent of the immutable creator/source ownership proof.
export function billingExpenseScope(ledger: Pick<BillingLedgerResourceRecord, 'cloudResourceType' | 'billingScope' | 'ownerUserId'>, productCode?: string) {
  return ['snapshot', 'image'].includes(ledger.cloudResourceType) || productCode === 'snapshot'
    ? { billingScope: 'platform' as const, ownerUserId: null }
    : { billingScope: ledger.billingScope, ownerUserId: ledger.ownerUserId };
}
