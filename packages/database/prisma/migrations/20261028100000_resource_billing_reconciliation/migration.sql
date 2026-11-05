ALTER TABLE "CloudWorkspace" ADD COLUMN "billingReconciliationMode" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "billingWriterGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingNextRequestAt" TIMESTAMP(3);
ALTER TABLE "BillingLineItem" ADD COLUMN "financialGroupKey" TEXT, ADD COLUMN "revisionId" TEXT;
ALTER TABLE "BillingAnomaly" ADD COLUMN "financialGroupKey" TEXT, ADD COLUMN "revisionId" TEXT;
CREATE INDEX "BillingLineItem_cloudWorkspaceId_financialGroupKey_idx" ON "BillingLineItem"("cloudWorkspaceId","financialGroupKey");
CREATE TABLE "BillingCoverageUnit" (
  "id" TEXT NOT NULL PRIMARY KEY, "cloudWorkspaceId" TEXT NOT NULL, "ledgerId" TEXT NOT NULL,
  "category" TEXT NOT NULL, "billingDate" DATE NOT NULL, "ruleVersion" INTEGER NOT NULL DEFAULT 1,
  "state" TEXT NOT NULL DEFAULT 'awaiting_query', "reasonCode" TEXT, "reasonMessage" TEXT,
  "queryTaskId" TEXT, "adoptedAttemptId" TEXT, "lastAttemptId" TEXT, "parentBillingResourceId" TEXT,
  "lastQueriedAt" TIMESTAMP(3), "lastVerifiedAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCoverageUnit_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingCoverageUnit_cloudWorkspaceId_ledgerId_category_billingDate_ruleVersion_key"
  ON "BillingCoverageUnit"("cloudWorkspaceId","ledgerId","category","billingDate","ruleVersion");
CREATE INDEX "BillingCoverageUnit_cloudWorkspaceId_state_billingDate_idx" ON "BillingCoverageUnit"("cloudWorkspaceId","state","billingDate");
CREATE INDEX "BillingCoverageUnit_cloudWorkspaceId_queryTaskId_idx" ON "BillingCoverageUnit"("cloudWorkspaceId","queryTaskId");
CREATE TABLE "BillingReconcileTask" (
  "id" TEXT NOT NULL PRIMARY KEY, "cloudWorkspaceId" TEXT NOT NULL, "cloudProvider" "CloudProvider" NOT NULL,
  "cloudAccountUid" TEXT NOT NULL, "cloudAccountContextId" TEXT NOT NULL, "regionId" TEXT NOT NULL,
  "billingDate" DATE NOT NULL, "groupKey" TEXT NOT NULL, "kind" TEXT NOT NULL, "instanceId" TEXT, "splitItemId" TEXT,
  "productCode" TEXT, "targetLedgerIds" TEXT[] NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "writerGeneration" INTEGER NOT NULL, "attemptCount" INTEGER NOT NULL DEFAULT 0, "currentRevisionId" TEXT,
  "lastQueriedAt" TIMESTAMP(3), "lastVerifiedAt" TIMESTAMP(3), "lastErrorCode" TEXT, "lastErrorMessage" TEXT,
  "queryPlan" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingReconcileTask_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingReconcileTask_cloudWorkspaceId_groupKey_key" ON "BillingReconcileTask"("cloudWorkspaceId","groupKey");
CREATE INDEX "BillingReconcileTask_cloudWorkspaceId_status_availableAt_idx" ON "BillingReconcileTask"("cloudWorkspaceId","status","availableAt");
CREATE INDEX "BillingReconcileTask_leaseExpiresAt_idx" ON "BillingReconcileTask"("leaseExpiresAt");
CREATE TABLE "BillingQueryAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY, "cloudWorkspaceId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  "outcome" TEXT NOT NULL DEFAULT 'running', "querySnapshot" JSONB NOT NULL DEFAULT '{}',
  "requestIds" JSONB NOT NULL DEFAULT '[]', "pageCount" INTEGER NOT NULL DEFAULT 0, "rowCount" INTEGER NOT NULL DEFAULT 0,
  "complete" BOOLEAN NOT NULL DEFAULT FALSE, "errorCode" TEXT, "errorMessage" TEXT, "datasetDigest" TEXT,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "BillingQueryAttempt_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BillingQueryAttempt_cloudWorkspaceId_taskId_startedAt_idx" ON "BillingQueryAttempt"("cloudWorkspaceId","taskId","startedAt");
