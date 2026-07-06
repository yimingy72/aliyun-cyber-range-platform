CREATE TABLE "CloudImageSnapshot" (
    "id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "accountUid" TEXT,
    "accountScopeKey" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "sourceImageName" TEXT NOT NULL,
    "osType" TEXT,
    "platform" TEXT,
    "architecture" TEXT,
    "status" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudImageSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageCatalogItem" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "scope" TEXT NOT NULL,
    "accountUid" TEXT,
    "accountScopeKey" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudImageSnapshot_provider_accountScopeKey_regionId_scope_imageId_key"
ON "CloudImageSnapshot"("provider", "accountScopeKey", "regionId", "scope", "imageId");

CREATE INDEX "CloudImageSnapshot_provider_regionId_scope_idx"
ON "CloudImageSnapshot"("provider", "regionId", "scope");

CREATE INDEX "CloudImageSnapshot_accountUid_idx"
ON "CloudImageSnapshot"("accountUid");

CREATE UNIQUE INDEX "ImageCatalogItem_provider_accountScopeKey_regionId_scope_imageId_key"
ON "ImageCatalogItem"("provider", "accountScopeKey", "regionId", "scope", "imageId");

CREATE INDEX "ImageCatalogItem_provider_regionId_scope_idx"
ON "ImageCatalogItem"("provider", "regionId", "scope");

CREATE INDEX "ImageCatalogItem_accountUid_idx"
ON "ImageCatalogItem"("accountUid");

CREATE INDEX "ImageCatalogItem_sourceSnapshotId_idx"
ON "ImageCatalogItem"("sourceSnapshotId");

ALTER TABLE "ImageCatalogItem"
ADD CONSTRAINT "ImageCatalogItem_sourceSnapshotId_fkey"
FOREIGN KEY ("sourceSnapshotId") REFERENCES "CloudImageSnapshot"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
