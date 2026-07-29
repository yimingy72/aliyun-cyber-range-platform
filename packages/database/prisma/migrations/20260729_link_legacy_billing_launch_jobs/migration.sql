WITH launch_jobs AS (
  SELECT DISTINCT ON ("rangeInstanceId")
    "rangeInstanceId",
    "id"
  FROM "ProvisionJob"
  WHERE "jobType" IN ('create', 'retry')
  ORDER BY
    "rangeInstanceId",
    CASE WHEN "status" = 'succeeded' THEN 0 ELSE 1 END,
    COALESCE("finishedAt", "startedAt", "createdAt") DESC,
    "id" DESC
)
UPDATE "BillingLedgerResource" AS ledger
SET
  "sourceProvisionJobId" = launch_jobs."id",
  "updatedAt" = CURRENT_TIMESTAMP
FROM launch_jobs
WHERE
  ledger."rangeInstanceId" = launch_jobs."rangeInstanceId"
  AND (
    ledger."sourceProvisionJobId" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "ProvisionJob" AS current_job
      WHERE
        current_job."id" = ledger."sourceProvisionJobId"
        AND current_job."jobType" IN ('create', 'retry')
    )
  );
