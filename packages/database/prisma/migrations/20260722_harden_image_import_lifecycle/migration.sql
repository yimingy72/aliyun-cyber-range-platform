ALTER TABLE "ImageImportJob" ADD COLUMN "lastPolledAt" TIMESTAMP(3);

CREATE INDEX "ImageImportJob_status_lastPolledAt_createdAt_idx"
ON "ImageImportJob"("status", "lastPolledAt", "createdAt");
