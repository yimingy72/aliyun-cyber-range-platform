ALTER TABLE "SingleInstanceNetworkProfile" ADD COLUMN "cloudAccountUid" TEXT NOT NULL DEFAULT 'legacy-unbound',
ADD COLUMN "cloudAccountContextId" TEXT, ADD COLUMN "workspaceKey" TEXT,
ADD COLUMN "managedByPlatform" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready',
ADD COLUMN "createdByUserId" TEXT, ADD COLUMN "cleanupRunId" TEXT,
ADD COLUMN "cleanupRegisteredByUserId" TEXT, ADD COLUMN "cleanupOwnerUserIds" JSONB;
DROP INDEX "SingleInstanceNetworkProfile_provider_regionId_zoneId_key";
CREATE UNIQUE INDEX "SingleInstanceNetworkProfile_provider_cloudAccountUid_regionId_zoneId_key"
ON "SingleInstanceNetworkProfile"("provider", "cloudAccountUid", "regionId", "zoneId");
