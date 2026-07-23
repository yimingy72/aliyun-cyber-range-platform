UPDATE "BillingLedgerResource"
SET
  "billingScope" = 'platform',
  "ownerUserId" = NULL
WHERE "cloudResourceType" IN ('image', 'snapshot');

UPDATE "BillingLineItem"
SET
  "billingScope" = 'platform',
  "ownerUserId" = NULL
WHERE "matchedLedgerId" IN (
  SELECT "id"
  FROM "BillingLedgerResource"
  WHERE "cloudResourceType" IN ('image', 'snapshot')
);
