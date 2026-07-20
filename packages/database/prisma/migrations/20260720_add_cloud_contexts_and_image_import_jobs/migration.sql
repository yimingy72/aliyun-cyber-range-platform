CREATE TYPE "CloudAccountContextStatus" AS ENUM ('provisioning', 'ready', 'degraded', 'disabled');
CREATE TYPE "ImageImportJobStatus" AS ENUM ('awaiting_upload', 'importing', 'available', 'failed', 'cancelled');

CREATE TABLE "CloudAccountContext" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "provider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
  "accountUid" TEXT NOT NULL,
  "regionId" TEXT NOT NULL,
  "zoneId" TEXT NOT NULL,
  "accessKeyId" TEXT NOT NULL,
  "accessKeySecret" TEXT NOT NULL,
  "imageImportBucket" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "status" "CloudAccountContextStatus" NOT NULL DEFAULT 'provisioning',
  "bucketStatus" TEXT NOT NULL DEFAULT 'pending',
  "lastError" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudAccountContext_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudAccountContext_provider_accountUid_regionId_key"
ON "CloudAccountContext"("provider", "accountUid", "regionId");
CREATE INDEX "CloudAccountContext_status_provider_idx"
ON "CloudAccountContext"("status", "provider");
CREATE INDEX "CloudAccountContext_isActive_idx" ON "CloudAccountContext"("isActive");

CREATE TABLE "ImageImportJob" (
  "id" TEXT NOT NULL,
  "cloudAccountContextId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "defaultHostName" TEXT,
  "defaultPassword" TEXT,
  "description" TEXT,
  "osType" TEXT NOT NULL,
  "platform" TEXT,
  "architecture" TEXT NOT NULL,
  "bootMode" TEXT NOT NULL,
  "imageFormat" TEXT NOT NULL,
  "systemDiskSize" INTEGER NOT NULL,
  "sourceFileName" TEXT NOT NULL,
  "sourceContentType" TEXT NOT NULL,
  "sourceSizeBytes" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "uploadExpiresAt" TIMESTAMP(3) NOT NULL,
  "uploadCompletedAt" TIMESTAMP(3),
  "status" "ImageImportJobStatus" NOT NULL DEFAULT 'awaiting_upload',
  "imageId" TEXT,
  "taskId" TEXT,
  "sourceSnapshotId" TEXT,
  "platformImageAssetId" TEXT,
  "temporaryObjectDeletedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImageImportJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageImportJob_objectKey_key" ON "ImageImportJob"("objectKey");
CREATE UNIQUE INDEX "ImageImportJob_imageId_key" ON "ImageImportJob"("imageId");
CREATE INDEX "ImageImportJob_cloudAccountContextId_status_updatedAt_idx"
ON "ImageImportJob"("cloudAccountContextId", "status", "updatedAt");
CREATE INDEX "ImageImportJob_ownerUserId_createdAt_idx" ON "ImageImportJob"("ownerUserId", "createdAt");
CREATE INDEX "ImageImportJob_status_temporaryObjectDeletedAt_updatedAt_idx"
ON "ImageImportJob"("status", "temporaryObjectDeletedAt", "updatedAt");

ALTER TABLE "ImageImportJob"
ADD CONSTRAINT "ImageImportJob_cloudAccountContextId_fkey"
FOREIGN KEY ("cloudAccountContextId") REFERENCES "CloudAccountContext"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ImageImportJob"
ADD CONSTRAINT "ImageImportJob_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "PlatformUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
