CREATE TYPE "CloudResourceDriftSeverity" AS ENUM ('warning', 'critical');

CREATE TABLE "CloudResourceDrift" (
    "id" TEXT NOT NULL,
    "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "regionId" TEXT NOT NULL,
    "cloudResourceType" TEXT NOT NULL,
    "cloudResourceId" TEXT NOT NULL,
    "rangeInstanceId" TEXT,
    "severity" "CloudResourceDriftSeverity" NOT NULL DEFAULT 'critical',
    "reason" TEXT NOT NULL,
    "tagsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudResourceDrift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudResourceDrift_cloudProvider_regionId_cloudResourceType_cloudResourceId_key"
ON "CloudResourceDrift"("cloudProvider", "regionId", "cloudResourceType", "cloudResourceId");

CREATE INDEX "CloudResourceDrift_severity_resolvedAt_lastSeenAt_idx"
ON "CloudResourceDrift"("severity", "resolvedAt", "lastSeenAt");

CREATE INDEX "CloudResourceDrift_rangeInstanceId_idx"
ON "CloudResourceDrift"("rangeInstanceId");
