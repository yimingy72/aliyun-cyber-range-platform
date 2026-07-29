WITH orphaned_instances AS (
  SELECT
    ledger."rangeInstanceId",
    MIN(ledger."billingStartAt") AS "firstBillingAt",
    MAX(ledger."ownerUserId") AS "ownerUserId"
  FROM "BillingLedgerResource" AS ledger
  LEFT JOIN "ProvisionJob" AS job
    ON job."id" = ledger."sourceProvisionJobId"
  WHERE
    ledger."rangeInstanceId" IS NOT NULL
    AND ledger."sourceProvisionJobId" IS NOT NULL
    AND job."id" IS NULL
  GROUP BY ledger."rangeInstanceId"
)
INSERT INTO "RangeInstance" (
  "id",
  "name",
  "createdBy",
  "ownerUserId",
  "status",
  "instanceMode",
  "errorSummary",
  "createdAt",
  "updatedAt"
)
SELECT
  orphaned."rangeInstanceId",
  CONCAT('历史归档失败编排实例-', RIGHT(orphaned."rangeInstanceId", 8)),
  'admin',
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM "PlatformUser" AS owner
      WHERE owner."id" = orphaned."ownerUserId"
    ) THEN orphaned."ownerUserId"
    ELSE NULL
  END,
  'create_failed',
  'range',
  '历史创建失败记录已从账单台账恢复。',
  orphaned."firstBillingAt",
  orphaned."firstBillingAt"
FROM orphaned_instances AS orphaned
LEFT JOIN "RangeInstance" AS instance
  ON instance."id" = orphaned."rangeInstanceId"
WHERE instance."id" IS NULL;

WITH orphaned_jobs AS (
  SELECT
    ledger."rangeInstanceId",
    ledger."sourceProvisionJobId",
    MIN(ledger."billingStartAt") AS "firstBillingAt"
  FROM "BillingLedgerResource" AS ledger
  LEFT JOIN "ProvisionJob" AS job
    ON job."id" = ledger."sourceProvisionJobId"
  WHERE
    ledger."rangeInstanceId" IS NOT NULL
    AND ledger."sourceProvisionJobId" IS NOT NULL
    AND job."id" IS NULL
  GROUP BY ledger."rangeInstanceId", ledger."sourceProvisionJobId"
)
INSERT INTO "ProvisionJob" (
  "id",
  "rangeInstanceId",
  "jobType",
  "status",
  "triggeredBy",
  "startedAt",
  "finishedAt",
  "errorSummary",
  "createdAt",
  "updatedAt"
)
SELECT
  orphaned."sourceProvisionJobId",
  orphaned."rangeInstanceId",
  'create',
  'failed',
  COALESCE(instance."ownerUserId", instance."createdBy", 'admin'),
  orphaned."firstBillingAt",
  orphaned."firstBillingAt",
  '历史创建失败作业已从账单台账恢复。',
  orphaned."firstBillingAt",
  orphaned."firstBillingAt"
FROM orphaned_jobs AS orphaned
JOIN "RangeInstance" AS instance
  ON instance."id" = orphaned."rangeInstanceId"
ON CONFLICT ("id") DO NOTHING;

WITH recovered_last_jobs AS (
  SELECT DISTINCT ON (ledger."rangeInstanceId")
    ledger."rangeInstanceId",
    ledger."sourceProvisionJobId"
  FROM "BillingLedgerResource" AS ledger
  JOIN "ProvisionJob" AS job
    ON job."id" = ledger."sourceProvisionJobId"
    AND job."rangeInstanceId" = ledger."rangeInstanceId"
    AND job."jobType" IN ('create', 'retry')
  WHERE
    ledger."rangeInstanceId" IS NOT NULL
    AND ledger."sourceProvisionJobId" IS NOT NULL
  ORDER BY
    ledger."rangeInstanceId",
    ledger."billingStartAt" DESC,
    ledger."sourceProvisionJobId" DESC
)
UPDATE "RangeInstance" AS instance
SET
  "lastJobId" = recovered."sourceProvisionJobId",
  "updatedAt" = CURRENT_TIMESTAMP
FROM recovered_last_jobs AS recovered
WHERE
  instance."id" = recovered."rangeInstanceId"
  AND instance."status" = 'create_failed'
  AND instance."lastJobId" IS NULL;
