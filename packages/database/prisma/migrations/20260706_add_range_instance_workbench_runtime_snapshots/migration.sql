ALTER TYPE "ProvisionJobType" ADD VALUE IF NOT EXISTS 'update';

ALTER TABLE "RangeInstance"
ADD COLUMN "createdBy" TEXT,
ADD COLUMN "runtimeTopologyGraph" JSONB,
ADD COLUMN "runtimeScenarioTemplateSpec" JSONB,
ADD COLUMN "runtimeCompiledProvisionSpec" JSONB,
ADD COLUMN "draftTopologyGraph" JSONB,
ADD COLUMN "draftScenarioTemplateSpec" JSONB,
ADD COLUMN "draftCompiledProvisionSpec" JSONB,
ADD COLUMN "draftUpdatedBy" TEXT,
ADD COLUMN "draftUpdatedAt" TIMESTAMP(3);
