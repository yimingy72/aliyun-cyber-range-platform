-- Run only as an authorized operator with a read-only database role:
-- psql "$AUDIT_DATABASE_URL" -X -v workspace_id=EXACT_WORKSPACE_ID -f scripts/audit/lifecycle-billing.sql
-- These are review candidates, NOT cloud-absence proofs or a repair/money-transfer script.
\set ON_ERROR_STOP on
\if :{?workspace_id}
\else
  \echo 'workspace_id is required; no unscoped audit is allowed.'
  \quit 2
\endif
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

-- Verify the requested namespace before interpreting empty result sets.
SELECT EXISTS (SELECT 1 FROM "CloudWorkspace" WHERE id = :'workspace_id') AS valid_workspace \gset
\if :valid_workspace
\else
  ROLLBACK;
  \echo 'Unknown workspace_id; empty results are not a clean audit.'
  \quit 2
\endif
SELECT id AS workspace_id, provider, "accountUid"
FROM "CloudWorkspace" WHERE id = :'workspace_id';

-- 1. Terminal or expired runtime resources whose ledger has no verified release boundary.
-- Retained packed images, snapshots and import buckets have independent lifetimes and are excluded.
WITH candidates AS (
  SELECT l.id AS ledger_id, l."cloudProvider", l."regionId", l."cloudResourceType", l."cloudResourceId",
    i.id AS instance_id, i.status AS instance_status, i."expiresAt", i."lastJobId",
    j.status AS last_job_status, j."retryCount", l."sourceProvisionJobId",
    CASE WHEN i.status IN ('destroyed', 'create_failed', 'destroy_failed') THEN 'TERMINAL_RELEASE_UNVERIFIED'
      ELSE 'EXPIRED_RELEASE_UNVERIFIED' END AS risk
  FROM "BillingLedgerResource" l
  JOIN "RangeInstance" i ON i.id = l."rangeInstanceId" AND i."cloudWorkspaceId" = l."cloudWorkspaceId"
  LEFT JOIN "ProvisionJob" j ON j.id = i."lastJobId" AND j."cloudWorkspaceId" = i."cloudWorkspaceId" AND j."rangeInstanceId" = i.id
  WHERE l."cloudWorkspaceId" = :'workspace_id' AND l."releasedAt" IS NULL
    AND l."cloudResourceType" IN ('ecs', 'disk', 'eip', 'nat_gateway')
    AND (i.status IN ('destroyed', 'create_failed', 'destroy_failed') OR i."expiresAt" <= CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
)
SELECT *, count(*) OVER () AS candidate_count FROM candidates ORDER BY ledger_id LIMIT 500;

-- 2. Broken source joins/ownership. Do not silently attribute or close these ledger rows.
WITH candidates AS (
  SELECT l.id AS ledger_id, l."cloudProvider", l."regionId", l."cloudResourceType", l."cloudResourceId",
    l."rangeInstanceId", l."sourceProvisionJobId", 'SOURCE_IDENTITY_REVIEW' AS risk
  FROM "BillingLedgerResource" l
  LEFT JOIN "RangeInstance" i ON i.id = l."rangeInstanceId" AND i."cloudWorkspaceId" = l."cloudWorkspaceId"
  LEFT JOIN "ProvisionJob" j ON j.id = l."sourceProvisionJobId" AND j."cloudWorkspaceId" = l."cloudWorkspaceId"
  WHERE l."cloudWorkspaceId" = :'workspace_id' AND l."cloudResourceType" IN ('ecs', 'disk', 'eip', 'nat_gateway')
    AND (i.id IS NULL OR j.id IS NULL OR j."rangeInstanceId" IS DISTINCT FROM l."rangeInstanceId"
      OR j."jobType" NOT IN ('create', 'retry', 'update') OR i."cloudProvider" IS DISTINCT FROM l."cloudProvider"
      OR i."ownerUserId" IS DISTINCT FROM l."ownerUserId" OR i."singleInstanceBatchId" IS DISTINCT FROM l."singleInstanceBatchId")
)
SELECT *, count(*) OVER () AS candidate_count FROM candidates ORDER BY ledger_id LIMIT 500;

-- 3. Positive official bill rows dated AFTER the release day in the billing timezone.
-- Bill date is NOT service usage time; late settlement/adjustments are possible. Refunds are not leaks.
-- List exact rows/currencies without inventing a total or changing historical attribution.
WITH candidates AS (
  SELECT b.id AS bill_id, l.id AS ledger_id, b."cloudProvider", l."regionId", b."cloudResourceType", b."cloudResourceId",
    b."billingDate", l."releasedAt", b.currency, b."pretaxAmount", 'POST_RELEASE_BILLING_REVIEW' AS risk
  FROM "BillingLineItem" b
  JOIN "BillingLedgerResource" l ON l.id = b."matchedLedgerId" AND l."cloudWorkspaceId" = b."cloudWorkspaceId"
    AND l."cloudProvider" = b."cloudProvider" AND l."cloudAccountUid" = b."cloudAccountUid"
    AND l."cloudResourceId" = b."cloudResourceId" AND l."cloudResourceType" = b."cloudResourceType"
    AND l."ownerUserId" IS NOT DISTINCT FROM b."ownerUserId" AND l."billingScope" = b."billingScope"
  WHERE b."cloudWorkspaceId" = :'workspace_id' AND l."releasedAt" IS NOT NULL AND b."pretaxAmount" > 0
    AND b."billingDate"::date > ((l."releasedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date
)
SELECT *, count(*) OVER () AS candidate_count FROM candidates ORDER BY "billingDate" DESC, bill_id LIMIT 500;
-- 4. Imported rows whose stored attribution disagrees with their linked ledger.
WITH candidates AS (
  SELECT b.id AS bill_id, b."matchedLedgerId", b."cloudProvider", b."cloudResourceType", b."cloudResourceId",
    b."billingDate", b.currency, b."pretaxAmount", 'BILL_LEDGER_IDENTITY_REVIEW' AS risk
  FROM "BillingLineItem" b
  LEFT JOIN "BillingLedgerResource" l ON l.id = b."matchedLedgerId" AND l."cloudWorkspaceId" = b."cloudWorkspaceId"
  WHERE b."cloudWorkspaceId" = :'workspace_id' AND b."matchedLedgerId" IS NOT NULL
    AND (l.id IS NULL OR l."cloudProvider" IS DISTINCT FROM b."cloudProvider"
      OR l."cloudAccountUid" IS DISTINCT FROM b."cloudAccountUid" OR l."cloudResourceId" IS DISTINCT FROM b."cloudResourceId"
      OR l."cloudResourceType" IS DISTINCT FROM b."cloudResourceType" OR l."ownerUserId" IS DISTINCT FROM b."ownerUserId"
      OR l."billingScope" IS DISTINCT FROM b."billingScope")
)
SELECT *, count(*) OVER () AS candidate_count FROM candidates ORDER BY "billingDate" DESC, bill_id LIMIT 500;
ROLLBACK;
