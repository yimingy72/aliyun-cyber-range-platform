CREATE TYPE "BillingScope" AS ENUM ('user', 'platform');

CREATE TYPE "BillingLedgerResourceType" AS ENUM (
  'ecs',
  'disk',
  'eip',
  'nat_gateway',
  'snat_entry',
  'dnat_entry',
  'image',
  'snapshot',
  'snapshot_region',
  'unknown'
);

CREATE TABLE "BillingLedgerResource" (
  "id" TEXT NOT NULL,
  "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
  "cloudAccountUid" TEXT,
  "regionId" TEXT NOT NULL,
  "cloudResourceId" TEXT NOT NULL,
  "cloudResourceType" "BillingLedgerResourceType" NOT NULL,
  "billingScope" "BillingScope" NOT NULL,
  "ownerUserId" TEXT,
  "rangeInstanceId" TEXT,
  "singleInstanceBatchId" TEXT,
  "platformImageAssetId" TEXT,
  "sourceProvisionJobId" TEXT,
  "billingStartAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "tagsSnapshot" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingLedgerResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingLineItem" (
  "id" TEXT NOT NULL,
  "syncBatchId" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "billCycle" TEXT NOT NULL,
  "billingDate" TIMESTAMP(3) NOT NULL,
  "productCode" TEXT NOT NULL,
  "productDetail" TEXT,
  "billItem" TEXT NOT NULL,
  "cloudResourceId" TEXT NOT NULL,
  "cloudResourceType" "BillingLedgerResourceType" NOT NULL,
  "pretaxAmount" DECIMAL(20,9) NOT NULL,
  "currency" TEXT NOT NULL,
  "billingScope" "BillingScope" NOT NULL,
  "ownerUserId" TEXT,
  "matchedLedgerId" TEXT,
  "rawPayload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingLineItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingAnomaly" (
  "id" TEXT NOT NULL,
  "syncBatchId" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "billCycle" TEXT NOT NULL,
  "billingDate" TIMESTAMP(3) NOT NULL,
  "cloudResourceId" TEXT NOT NULL,
  "cloudResourceType" "BillingLedgerResourceType" NOT NULL,
  "pretaxAmount" DECIMAL(20,9) NOT NULL,
  "currency" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "rawPayload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingAnomaly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingLedgerResource_cloudProvider_regionId_cloudResourceId_cloudResourceType_key"
ON "BillingLedgerResource"("cloudProvider", "regionId", "cloudResourceId", "cloudResourceType");

CREATE INDEX "BillingLedgerResource_ownerUserId_billingScope_billingStartAt_idx"
ON "BillingLedgerResource"("ownerUserId", "billingScope", "billingStartAt");

CREATE INDEX "BillingLedgerResource_rangeInstanceId_idx"
ON "BillingLedgerResource"("rangeInstanceId");

CREATE INDEX "BillingLedgerResource_singleInstanceBatchId_idx"
ON "BillingLedgerResource"("singleInstanceBatchId");

CREATE INDEX "BillingLedgerResource_platformImageAssetId_idx"
ON "BillingLedgerResource"("platformImageAssetId");

CREATE UNIQUE INDEX "BillingLineItem_sourceFingerprint_key"
ON "BillingLineItem"("sourceFingerprint");

CREATE INDEX "BillingLineItem_billingDate_billingScope_idx"
ON "BillingLineItem"("billingDate", "billingScope");

CREATE INDEX "BillingLineItem_ownerUserId_billingDate_idx"
ON "BillingLineItem"("ownerUserId", "billingDate");

CREATE INDEX "BillingLineItem_matchedLedgerId_idx"
ON "BillingLineItem"("matchedLedgerId");

CREATE INDEX "BillingLineItem_cloudResourceId_cloudResourceType_idx"
ON "BillingLineItem"("cloudResourceId", "cloudResourceType");

CREATE UNIQUE INDEX "BillingAnomaly_sourceFingerprint_key"
ON "BillingAnomaly"("sourceFingerprint");

CREATE INDEX "BillingAnomaly_billingDate_idx"
ON "BillingAnomaly"("billingDate");

CREATE INDEX "BillingAnomaly_cloudResourceId_cloudResourceType_idx"
ON "BillingAnomaly"("cloudResourceId", "cloudResourceType");
