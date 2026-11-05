ALTER TYPE "ProvisionJobType" ADD VALUE IF NOT EXISTS 'economical_stop';
ALTER TYPE "ProvisionJobType" ADD VALUE IF NOT EXISTS 'resume';
ALTER TABLE "RangeInstance" ADD COLUMN "powerControl" JSONB;
