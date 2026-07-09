CREATE TABLE "SingleInstanceBatch" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "platformImageAssetId" TEXT NOT NULL,
  "imageId" TEXT NOT NULL,
  "imageDisplayName" TEXT NOT NULL,
  "cpu" INTEGER NOT NULL,
  "memory" INTEGER NOT NULL,
  "systemDiskSize" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "remark" TEXT,
  "createdBy" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SingleInstanceBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RangeInstance"
  ADD COLUMN "singleInstanceBatchId" TEXT;

CREATE INDEX "SingleInstanceBatch_createdAt_idx" ON "SingleInstanceBatch"("createdAt");
CREATE INDEX "RangeInstance_singleInstanceBatchId_idx" ON "RangeInstance"("singleInstanceBatchId");

ALTER TABLE "RangeInstance"
  ADD CONSTRAINT "RangeInstance_singleInstanceBatchId_fkey"
  FOREIGN KEY ("singleInstanceBatchId")
  REFERENCES "SingleInstanceBatch"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
