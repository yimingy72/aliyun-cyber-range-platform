ALTER TABLE "RangeInstance"
ADD COLUMN "templateNameSnapshot" TEXT,
ADD COLUMN "templateSlugSnapshot" TEXT,
ADD COLUMN "templateVersionSnapshot" TEXT,
ADD COLUMN "templateModulePathSnapshot" TEXT;

ALTER TABLE "RangeInstance"
ALTER COLUMN "templateId" DROP NOT NULL;

ALTER TABLE "RangeInstance"
DROP CONSTRAINT "RangeInstance_templateId_fkey";

ALTER TABLE "RangeInstance"
ADD CONSTRAINT "RangeInstance_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "RangeTemplate"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
