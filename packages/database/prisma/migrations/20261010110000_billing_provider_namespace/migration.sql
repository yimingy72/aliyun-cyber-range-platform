ALTER TABLE "BillingLineItem" ADD COLUMN "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud';
ALTER TABLE "BillingAnomaly" ADD COLUMN "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud';
DROP INDEX "BillingLineItem_cloudWorkspaceId_sourceFingerprint_key";
DROP INDEX "BillingAnomaly_cloudWorkspaceId_sourceFingerprint_key";
CREATE UNIQUE INDEX "BillingLineItem_workspace_provider_fingerprint_key" ON "BillingLineItem"("cloudWorkspaceId", "cloudProvider", "sourceFingerprint");
CREATE UNIQUE INDEX "BillingAnomaly_workspace_provider_fingerprint_key" ON "BillingAnomaly"("cloudWorkspaceId", "cloudProvider", "sourceFingerprint");
CREATE INDEX "BillingLineItem_workspace_provider_account_date_idx" ON "BillingLineItem"("cloudWorkspaceId", "cloudProvider", "cloudAccountUid", "billingDate");
CREATE INDEX "BillingAnomaly_workspace_provider_account_date_idx" ON "BillingAnomaly"("cloudWorkspaceId", "cloudProvider", "cloudAccountUid", "billingDate");
