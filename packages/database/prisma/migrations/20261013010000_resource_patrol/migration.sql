ALTER TABLE "CloudResourceDrift"
 ADD COLUMN "patrolStatus" TEXT NOT NULL DEFAULT 'unverified',
 ADD COLUMN "accountUid" TEXT,
 ADD COLUMN "sourceEvidence" JSONB NOT NULL DEFAULT '{}',
 ADD COLUMN "remainingResources" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "reclaimJobId" TEXT,
 ADD COLUMN "reclaimKey" TEXT,
 ADD COLUMN "errorSummary" TEXT;
UPDATE "CloudResourceDrift" SET "patrolStatus"='resolved' WHERE "resolvedAt" IS NOT NULL;
CREATE TABLE "ResourcePatrolSettings" (
 "id" TEXT PRIMARY KEY, "managerUserId" TEXT, "lastScanAt" TIMESTAMP(3), "lastScanWorkspaceId" TEXT, "lastScanError" TEXT,
 "regions" JSONB NOT NULL DEFAULT '[]', "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "CloudResourceDrift" ADD CONSTRAINT "CloudResourceDrift_patrol_status_check"
 CHECK ("patrolStatus" IN ('pending','unverified','reclaiming','failed','resolved'));
CREATE INDEX "CloudResourceDrift_patrol_list_idx" ON "CloudResourceDrift"("cloudWorkspaceId", "patrolStatus", "lastSeenAt");
