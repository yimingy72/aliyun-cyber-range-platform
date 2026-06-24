-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CompetitionStatus" AS ENUM ('draft', 'scheduled', 'active', 'completed');

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('alibaba_cloud');

-- CreateEnum
CREATE TYPE "IacType" AS ENUM ('opentofu', 'terraform');

-- CreateEnum
CREATE TYPE "RangeInstanceStatus" AS ENUM ('draft', 'pending_create', 'creating', 'running', 'create_failed', 'pending_destroy', 'destroying', 'destroy_failed', 'destroyed');

-- CreateEnum
CREATE TYPE "ProvisionJobType" AS ENUM ('create', 'destroy', 'retry', 'refresh_status');

-- CreateEnum
CREATE TYPE "ProvisionJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProvisionJobStepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "Competition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CompetitionStatus" NOT NULL DEFAULT 'draft',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "defaultTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmailOrPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RangeTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "iacType" "IacType" NOT NULL DEFAULT 'opentofu',
    "modulePathOrRef" TEXT NOT NULL,
    "variableSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "defaultNetworkPolicy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RangeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RangeInstance" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "RangeInstanceStatus" NOT NULL DEFAULT 'draft',
    "allocatedCidr" TEXT,
    "cloudProvider" "CloudProvider" NOT NULL DEFAULT 'alibaba_cloud',
    "accessEntry" JSONB,
    "resourceSummary" JSONB,
    "expiresAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RangeInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionJob" (
    "id" TEXT NOT NULL,
    "rangeInstanceId" TEXT NOT NULL,
    "jobType" "ProvisionJobType" NOT NULL,
    "status" "ProvisionJobStatus" NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionJobStepLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "status" "ProvisionJobStepStatus" NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "stdoutExcerpt" TEXT,
    "stderrExcerpt" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisionJobStepLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Competition_status_idx" ON "Competition"("status");

-- CreateIndex
CREATE INDEX "Team_competitionId_idx" ON "Team"("competitionId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_competitionId_name_key" ON "Team"("competitionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RangeTemplate_slug_version_key" ON "RangeTemplate"("slug", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RangeInstance_lastJobId_key" ON "RangeInstance"("lastJobId");

-- CreateIndex
CREATE INDEX "RangeInstance_competitionId_idx" ON "RangeInstance"("competitionId");

-- CreateIndex
CREATE INDEX "RangeInstance_teamId_idx" ON "RangeInstance"("teamId");

-- CreateIndex
CREATE INDEX "RangeInstance_templateId_idx" ON "RangeInstance"("templateId");

-- CreateIndex
CREATE INDEX "RangeInstance_status_idx" ON "RangeInstance"("status");

-- CreateIndex
CREATE INDEX "ProvisionJob_rangeInstanceId_idx" ON "ProvisionJob"("rangeInstanceId");

-- CreateIndex
CREATE INDEX "ProvisionJob_status_idx" ON "ProvisionJob"("status");

-- CreateIndex
CREATE INDEX "ProvisionJobStepLog_jobId_idx" ON "ProvisionJobStepLog"("jobId");

-- CreateIndex
CREATE INDEX "ProvisionJobStepLog_status_idx" ON "ProvisionJobStepLog"("status");

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_defaultTemplateId_fkey" FOREIGN KEY ("defaultTemplateId") REFERENCES "RangeTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeInstance" ADD CONSTRAINT "RangeInstance_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeInstance" ADD CONSTRAINT "RangeInstance_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeInstance" ADD CONSTRAINT "RangeInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RangeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeInstance" ADD CONSTRAINT "RangeInstance_lastJobId_fkey" FOREIGN KEY ("lastJobId") REFERENCES "ProvisionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionJob" ADD CONSTRAINT "ProvisionJob_rangeInstanceId_fkey" FOREIGN KEY ("rangeInstanceId") REFERENCES "RangeInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionJobStepLog" ADD CONSTRAINT "ProvisionJobStepLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProvisionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
