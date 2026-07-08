CREATE TYPE "RangeInstanceMode" AS ENUM ('range', 'single');

ALTER TABLE "RangeTemplate"
ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'admin';

ALTER TABLE "RangeInstance"
ALTER COLUMN "createdBy" SET DEFAULT 'admin',
ADD COLUMN "instanceMode" "RangeInstanceMode" NOT NULL DEFAULT 'range',
ADD COLUMN "singleInstanceConfig" JSONB;

CREATE INDEX "RangeInstance_instanceMode_status_idx"
ON "RangeInstance"("instanceMode", "status");

CREATE TABLE "SingleInstanceNetworkProfile" (
    "id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "regionId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "vpcId" TEXT NOT NULL,
    "vpcCidr" TEXT NOT NULL,
    "vswitchIds" JSONB NOT NULL,
    "vswitchCidrs" JSONB NOT NULL,
    "securityGroupId" TEXT NOT NULL,
    "securityGroupName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SingleInstanceNetworkProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SingleInstanceNetworkProfile_provider_regionId_zoneId_key"
ON "SingleInstanceNetworkProfile"("provider", "regionId", "zoneId");
