ALTER TABLE "RangeTemplate"
ADD COLUMN IF NOT EXISTS "scenarioTemplateSpec" JSONB,
ADD COLUMN IF NOT EXISTS "compiledProvisionSpec" JSONB;

ALTER TABLE "RangeTemplateVersion"
ADD COLUMN IF NOT EXISTS "scenarioTemplateSpec" JSONB,
ADD COLUMN IF NOT EXISTS "compiledProvisionSpec" JSONB;
