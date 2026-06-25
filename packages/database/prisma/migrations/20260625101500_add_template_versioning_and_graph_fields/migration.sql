-- CreateEnum
CREATE TYPE "RangeTemplateVersionStatus" AS ENUM ('draft', 'published', 'archived');

-- AlterTable
ALTER TABLE "RangeTemplate"
ADD COLUMN "topologyGraph" JSONB,
ADD COLUMN "compiledSpec" JSONB,
ADD COLUMN "currentDraftVersionId" TEXT,
ADD COLUMN "currentPublishedVersionId" TEXT;

-- CreateTable
CREATE TABLE "RangeTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "RangeTemplateVersionStatus" NOT NULL DEFAULT 'draft',
    "modulePathOrRef" TEXT NOT NULL,
    "topologySpec" JSONB,
    "topologyGraph" JSONB,
    "compiledSpec" JSONB,
    "variableSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "defaultNetworkPolicy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RangeTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- Backfill an initial draft version for templates that predate versioning.
INSERT INTO "RangeTemplateVersion" (
    "id",
    "templateId",
    "version",
    "status",
    "modulePathOrRef",
    "topologySpec",
    "topologyGraph",
    "compiledSpec",
    "variableSchema",
    "outputSchema",
    "defaultNetworkPolicy",
    "createdAt",
    "updatedAt"
)
SELECT
    'rtv_initial_' || md5(rt."id" || ':draft'),
    rt."id",
    rt."version",
    'draft'::"RangeTemplateVersionStatus",
    rt."modulePathOrRef",
    rt."topologySpec",
    rt."topologyGraph",
    rt."compiledSpec",
    rt."variableSchema",
    rt."outputSchema",
    rt."defaultNetworkPolicy",
    rt."createdAt",
    rt."updatedAt"
FROM "RangeTemplate" rt
WHERE rt."currentDraftVersionId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "RangeTemplate" rt
SET "currentDraftVersionId" = seeded."id"
FROM (
    SELECT
        existing."templateId",
        existing."id"
    FROM "RangeTemplateVersion" existing
    WHERE existing."id" = 'rtv_initial_' || md5(existing."templateId" || ':draft')
) AS seeded
WHERE rt."id" = seeded."templateId"
  AND rt."currentDraftVersionId" IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "RangeTemplate"
        WHERE "currentDraftVersionId" IS NULL
    ) THEN
        RAISE EXCEPTION 'RangeTemplate version backfill incomplete: some templates still have NULL currentDraftVersionId';
    END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "RangeTemplate_currentDraftVersionId_key" ON "RangeTemplate"("currentDraftVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RangeTemplate_currentPublishedVersionId_key" ON "RangeTemplate"("currentPublishedVersionId");

-- CreateIndex
CREATE INDEX "RangeTemplateVersion_templateId_idx" ON "RangeTemplateVersion"("templateId");

-- CreateIndex
CREATE INDEX "RangeTemplateVersion_status_idx" ON "RangeTemplateVersion"("status");

-- AddForeignKey
ALTER TABLE "RangeTemplate" ADD CONSTRAINT "RangeTemplate_currentDraftVersionId_fkey" FOREIGN KEY ("currentDraftVersionId") REFERENCES "RangeTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeTemplate" ADD CONSTRAINT "RangeTemplate_currentPublishedVersionId_fkey" FOREIGN KEY ("currentPublishedVersionId") REFERENCES "RangeTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeTemplateVersion" ADD CONSTRAINT "RangeTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RangeTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
