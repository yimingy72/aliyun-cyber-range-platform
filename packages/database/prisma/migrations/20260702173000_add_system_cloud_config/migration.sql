CREATE TABLE "SystemCloudConfig" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "defaultRegion" TEXT NOT NULL,
    "defaultZoneId" TEXT NOT NULL,
    "accessKeyId" TEXT NOT NULL,
    "accessKeySecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemCloudConfig_pkey" PRIMARY KEY ("id")
);
