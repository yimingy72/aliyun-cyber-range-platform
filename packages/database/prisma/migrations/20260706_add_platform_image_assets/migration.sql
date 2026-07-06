CREATE TABLE "PlatformImageAsset" (
    "id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "accountUid" TEXT,
    "accountScopeKey" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "sourceScope" TEXT NOT NULL,
    "sourceSnapshotId" TEXT,
    "imageId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformImageAsset_provider_accountScopeKey_regionId_imageId_key"
ON "PlatformImageAsset"("provider", "accountScopeKey", "regionId", "imageId");

CREATE INDEX "PlatformImageAsset_provider_accountScopeKey_regionId_idx"
ON "PlatformImageAsset"("provider", "accountScopeKey", "regionId");

CREATE INDEX "PlatformImageAsset_sourceSnapshotId_idx"
ON "PlatformImageAsset"("sourceSnapshotId");

ALTER TABLE "PlatformImageAsset"
ADD CONSTRAINT "PlatformImageAsset_sourceSnapshotId_fkey"
FOREIGN KEY ("sourceSnapshotId") REFERENCES "CloudImageSnapshot"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
