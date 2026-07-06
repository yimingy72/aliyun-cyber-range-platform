ALTER TABLE "RangeInstance"
ADD COLUMN "sourceTemplateVersionId" TEXT;

CREATE INDEX "RangeInstance_sourceTemplateVersionId_idx"
ON "RangeInstance"("sourceTemplateVersionId");
