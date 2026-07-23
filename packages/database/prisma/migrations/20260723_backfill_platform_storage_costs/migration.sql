INSERT INTO "BillingLineItem" (
  "id",
  "syncBatchId",
  "sourceFingerprint",
  "billCycle",
  "billingDate",
  "productCode",
  "productDetail",
  "billItem",
  "cloudResourceId",
  "cloudResourceType",
  "pretaxAmount",
  "currency",
  "billingScope",
  "ownerUserId",
  "matchedLedgerId",
  "rawPayload",
  "createdAt",
  "updatedAt"
)
SELECT
  'migration-platform-storage-' || md5("id"),
  "syncBatchId",
  "sourceFingerprint",
  "billCycle",
  "billingDate",
  COALESCE(NULLIF("rawPayload" ->> 'ProductCode', ''), CASE WHEN "cloudResourceType" = 'snapshot_region' THEN 'snapshot' ELSE 'oss' END),
  NULLIF("rawPayload" ->> 'ProductDetail', ''),
  COALESCE(
    NULLIF("rawPayload" ->> 'BillingItem', ''),
    CASE WHEN "cloudResourceType" = 'snapshot_region' THEN '快照链容量' ELSE 'OSS 未细分费用' END
  ),
  "cloudResourceId",
  "cloudResourceType",
  "pretaxAmount",
  "currency",
  'platform'::"BillingScope",
  NULL,
  NULL,
  "rawPayload",
  "createdAt",
  "updatedAt"
FROM "BillingAnomaly"
WHERE
  "cloudResourceType" = 'snapshot_region'
  OR lower(COALESCE("rawPayload" ->> 'ProductCode', '')) = 'oss'
ON CONFLICT ("sourceFingerprint") DO UPDATE
SET
  "billingScope" = 'platform',
  "ownerUserId" = NULL,
  "matchedLedgerId" = NULL,
  "rawPayload" = EXCLUDED."rawPayload",
  "updatedAt" = EXCLUDED."updatedAt";

DELETE FROM "BillingAnomaly"
WHERE
  "cloudResourceType" = 'snapshot_region'
  OR lower(COALESCE("rawPayload" ->> 'ProductCode', '')) = 'oss';
