ALTER TABLE "ProvisionJob" ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "ProvisionJob_status_availableAt_createdAt_id_idx" ON "ProvisionJob"("status", "availableAt", "createdAt", "id");
CREATE INDEX "RangeInstance_status_expiresAt_idx" ON "RangeInstance"("status", "expiresAt");
