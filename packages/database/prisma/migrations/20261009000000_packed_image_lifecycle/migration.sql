CREATE TABLE "PackedImageArtifact" (
  "id" TEXT NOT NULL,
  "cloudAccountContextId" TEXT NOT NULL,
  "cloudAccountUid" TEXT NOT NULL,
  "regionId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "sourceRangeInstanceId" TEXT NOT NULL,
  "sourceHostKey" TEXT NOT NULL,
  "sourceInstanceId" TEXT NOT NULL,
  "sourceDiskIds" JSONB NOT NULL,
  "imageId" TEXT,
  "sourceSnapshotId" TEXT,
  "platformImageAssetId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "backingSnapshotIds" JSONB NOT NULL DEFAULT '[]',
  "deletedSnapshotIds" JSONB NOT NULL DEFAULT '[]',
  "cloudImageDeletedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastPolledAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackedImageArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PackedImageArtifact_imageId_key" ON "PackedImageArtifact"("imageId");
CREATE INDEX "PackedImageArtifact_cloudAccountUid_regionId_status_idx" ON "PackedImageArtifact"("cloudAccountUid", "regionId", "status");
CREATE INDEX "PackedImageArtifact_ownerUserId_createdAt_idx" ON "PackedImageArtifact"("ownerUserId", "createdAt");
CREATE INDEX "PackedImageArtifact_sourceSnapshotId_idx" ON "PackedImageArtifact"("sourceSnapshotId");
