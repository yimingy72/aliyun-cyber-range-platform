ALTER TABLE "BillingLineItem" ADD COLUMN "cloudAccountUid" TEXT;
ALTER TABLE "BillingAnomaly" ADD COLUMN "cloudAccountUid" TEXT;

-- Only proven ownership is migrated; unknown historical rows remain untouched.
UPDATE "BillingLineItem" b SET "cloudAccountUid" = l."cloudAccountUid"
FROM "BillingLedgerResource" l
WHERE b."matchedLedgerId" = l."id" AND l."cloudAccountUid" IS NOT NULL;
UPDATE "BillingLineItem" SET "cloudAccountUid" = NULLIF("rawPayload"->>'OwnerID', '')
WHERE "cloudAccountUid" IS NULL AND "rawPayload"->>'OwnerID' ~ '^[0-9]+$';
UPDATE "BillingAnomaly" SET "cloudAccountUid" = NULLIF("rawPayload"->>'OwnerID', '')
WHERE "rawPayload"->>'OwnerID' ~ '^[0-9]+$';

CREATE INDEX "BillingLineItem_cloudAccountUid_billingDate_idx" ON "BillingLineItem"("cloudAccountUid", "billingDate");
CREATE INDEX "BillingAnomaly_cloudAccountUid_billingDate_idx" ON "BillingAnomaly"("cloudAccountUid", "billingDate");
