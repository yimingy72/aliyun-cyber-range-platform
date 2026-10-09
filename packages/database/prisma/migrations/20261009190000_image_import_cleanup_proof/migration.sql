ALTER TABLE "ImageImportJob"
  ADD COLUMN "cloudAccountUid" TEXT,
  ADD COLUMN "regionId" TEXT,
  ADD COLUMN "imageImportBucket" TEXT,
  ADD COLUMN "submissionRejected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "backingSnapshotIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "deletedSnapshotIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "snapshotCleanupCompletedAt" TIMESTAMP(3),
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Cloud account contexts are durable identities; freeze the original import scope.
UPDATE "ImageImportJob" j SET
  "cloudAccountUid" = c."accountUid",
  "regionId" = c."regionId",
  "imageImportBucket" = c."imageImportBucket"
FROM "CloudAccountContext" c WHERE j."cloudAccountContextId" = c."id";
