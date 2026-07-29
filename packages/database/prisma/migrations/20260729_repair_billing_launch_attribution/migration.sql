WITH successful_launches AS (
  SELECT DISTINCT ON ("rangeInstanceId")
    "rangeInstanceId",
    "id"
  FROM "ProvisionJob"
  WHERE
    "status" = 'succeeded'
    AND "jobType" IN ('create', 'retry')
    AND "finishedAt" IS NOT NULL
  ORDER BY "rangeInstanceId", "finishedAt" DESC, "id" DESC
)
UPDATE "BillingLedgerResource" AS ledger
SET
  "sourceProvisionJobId" = successful_launches."id",
  "updatedAt" = CURRENT_TIMESTAMP
FROM successful_launches
WHERE
  ledger."rangeInstanceId" = successful_launches."rangeInstanceId"
  AND (
    ledger."sourceProvisionJobId" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "ProvisionJob" AS current_job
      WHERE
        current_job."id" = ledger."sourceProvisionJobId"
        AND current_job."status" = 'succeeded'
        AND current_job."jobType" IN ('create', 'retry')
        AND current_job."finishedAt" IS NOT NULL
    )
  );

INSERT INTO "BillingAnomaly" (
  "id",
  "syncBatchId",
  "sourceFingerprint",
  "billCycle",
  "billingDate",
  "cloudResourceId",
  "cloudResourceType",
  "pretaxAmount",
  "currency",
  "reason",
  "rawPayload",
  "createdAt",
  "updatedAt"
)
SELECT
  'migration-untracked-billing-' || md5("id"),
  "syncBatchId",
  "sourceFingerprint",
  "billCycle",
  "billingDate",
  "cloudResourceId",
  "cloudResourceType",
  "pretaxAmount",
  "currency",
  CASE
    WHEN "cloudResourceType" = 'snapshot_region' THEN
      '该账单是地域级快照链容量，BSS 未提供具体快照资源 ID 或平台标记，因此不计入平台费用。'
    WHEN lower(COALESCE("rawPayload" ->> 'ProductCode', '')) = 'oss' THEN
      '该 OSS 账单未提供可确认的平台 Bucket 标识，因此不计入平台费用。'
    ELSE
      '该账单未关联平台资源台账，因此不计入平台费用。'
  END,
  "rawPayload",
  "createdAt",
  "updatedAt"
FROM "BillingLineItem"
WHERE "matchedLedgerId" IS NULL
ON CONFLICT ("sourceFingerprint") DO UPDATE
SET
  "syncBatchId" = EXCLUDED."syncBatchId",
  "billCycle" = EXCLUDED."billCycle",
  "billingDate" = EXCLUDED."billingDate",
  "cloudResourceId" = EXCLUDED."cloudResourceId",
  "cloudResourceType" = EXCLUDED."cloudResourceType",
  "pretaxAmount" = EXCLUDED."pretaxAmount",
  "currency" = EXCLUDED."currency",
  "reason" = EXCLUDED."reason",
  "rawPayload" = EXCLUDED."rawPayload",
  "updatedAt" = EXCLUDED."updatedAt";

DELETE FROM "BillingLineItem"
WHERE "matchedLedgerId" IS NULL;
