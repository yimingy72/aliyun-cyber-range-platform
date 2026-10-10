ALTER TABLE "CloudImageSnapshot" ADD COLUMN "minimumSystemDiskSize" INTEGER;
ALTER TABLE "PackedImageArtifact" ADD COLUMN "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud';
ALTER TABLE "ImageImportJob" ADD COLUMN "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud', ADD COLUMN "managedBucketId" TEXT, ADD COLUMN "sourceObjectProof" JSONB, ADD COLUMN "sourceDiskIds" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "osVersion" TEXT;
CREATE TABLE "CloudImageImportBucket" (
  "id" TEXT PRIMARY KEY, "cloudWorkspaceId" TEXT NOT NULL, "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'tencent_cloud',
  "cloudAccountContextId" TEXT NOT NULL, "cloudAccountUid" TEXT NOT NULL, "appId" TEXT NOT NULL, "regionId" TEXT NOT NULL,
  "bucketName" TEXT NOT NULL, "creationNonce" TEXT NOT NULL, "activeSlot" TEXT, "creatorUserId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "preflightAbsentAt" TIMESTAMP(3), "creationStartedAt" TIMESTAMP(3), "creationRequestId" TEXT, "ownershipMarkerKey" TEXT NOT NULL, "ownershipProof" JSONB,
  "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3), "deletedAt" TIMESTAMP(3), "errorMessage" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudImageImportBucket_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CloudImageImportBucket_bucketName_key" ON "CloudImageImportBucket"("bucketName");
CREATE UNIQUE INDEX "CloudImageImportBucket_creationNonce_key" ON "CloudImageImportBucket"("creationNonce");
CREATE INDEX "CloudImageImportBucket_workspace_identity_idx" ON "CloudImageImportBucket"("cloudWorkspaceId", "cloudProvider", "cloudAccountUid", "regionId");
CREATE INDEX "CloudImageImportBucket_status_leaseExpiresAt_idx" ON "CloudImageImportBucket"("status", "leaseExpiresAt");

CREATE UNIQUE INDEX "CloudImageImportBucket_activeSlot_key" ON "CloudImageImportBucket"("activeSlot");
