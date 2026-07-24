CREATE TABLE "PlatformImageTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformImageTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformImageAssetTag" (
    "platformImageAssetId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformImageAssetTag_pkey" PRIMARY KEY ("platformImageAssetId", "tagId")
);

CREATE UNIQUE INDEX "PlatformImageTag_normalizedName_key" ON "PlatformImageTag"("normalizedName");
CREATE INDEX "PlatformImageTag_createdByUserId_idx" ON "PlatformImageTag"("createdByUserId");
CREATE INDEX "PlatformImageAssetTag_tagId_platformImageAssetId_idx" ON "PlatformImageAssetTag"("tagId", "platformImageAssetId");

ALTER TABLE "PlatformImageTag"
ADD CONSTRAINT "PlatformImageTag_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "PlatformUser"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PlatformImageAssetTag"
ADD CONSTRAINT "PlatformImageAssetTag_platformImageAssetId_fkey"
FOREIGN KEY ("platformImageAssetId") REFERENCES "PlatformImageAsset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformImageAssetTag"
ADD CONSTRAINT "PlatformImageAssetTag_tagId_fkey"
FOREIGN KEY ("tagId") REFERENCES "PlatformImageTag"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
