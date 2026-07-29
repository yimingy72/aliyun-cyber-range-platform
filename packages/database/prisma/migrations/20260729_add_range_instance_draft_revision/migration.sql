ALTER TABLE "RangeInstance"
ADD COLUMN "draftTopologySpec" JSONB,
ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0;
