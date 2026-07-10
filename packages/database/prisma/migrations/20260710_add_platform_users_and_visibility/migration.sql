CREATE TYPE "UserRole" AS ENUM ('admin', 'user');
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "ResourceVisibility" AS ENUM ('private', 'platform');

CREATE TABLE "PlatformUser" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'user',
  "status" "UserStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformUser_username_key" ON "PlatformUser"("username");

INSERT INTO "PlatformUser" ("id", "username", "passwordHash", "role", "status", "createdAt", "updatedAt")
VALUES (
  'admin',
  'admin',
  'platform-admin-seed.H81Ru6ixiqy6dL6sA8_nzY_ovVNGk3YycjsdSeQM8G6Q1cnzWFEvKQ5HsvDob-q0oBSc3oui5K9G2D-ZPtg79Q',
  'admin',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "PlatformImageAsset"
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'private';

ALTER TABLE "RangeTemplate"
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'private';

ALTER TABLE "RangeInstance"
ADD COLUMN "ownerUserId" TEXT;

ALTER TABLE "SingleInstanceBatch"
ADD COLUMN "ownerUserId" TEXT;

UPDATE "PlatformImageAsset"
SET "ownerUserId" = 'admin'
WHERE "ownerUserId" IS NULL;

UPDATE "PlatformImageAsset"
SET "visibility" = 'platform';

UPDATE "RangeTemplate"
SET "ownerUserId" = 'admin'
WHERE "ownerUserId" IS NULL;

UPDATE "RangeTemplate"
SET "visibility" = 'platform';

UPDATE "RangeInstance"
SET "ownerUserId" = 'admin'
WHERE "ownerUserId" IS NULL;

UPDATE "SingleInstanceBatch"
SET "ownerUserId" = 'admin'
WHERE "ownerUserId" IS NULL;

CREATE INDEX "PlatformImageAsset_ownerUserId_idx" ON "PlatformImageAsset"("ownerUserId");
CREATE INDEX "PlatformImageAsset_visibility_enabled_idx" ON "PlatformImageAsset"("visibility", "enabled");
CREATE INDEX "RangeTemplate_ownerUserId_idx" ON "RangeTemplate"("ownerUserId");
CREATE INDEX "RangeTemplate_visibility_updatedAt_idx" ON "RangeTemplate"("visibility", "updatedAt");
CREATE INDEX "RangeInstance_ownerUserId_createdAt_idx" ON "RangeInstance"("ownerUserId", "createdAt");
CREATE INDEX "SingleInstanceBatch_ownerUserId_createdAt_idx" ON "SingleInstanceBatch"("ownerUserId", "createdAt");

ALTER TABLE "PlatformImageAsset"
ADD CONSTRAINT "PlatformImageAsset_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "PlatformUser"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "RangeTemplate"
ADD CONSTRAINT "RangeTemplate_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "PlatformUser"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "RangeInstance"
ADD CONSTRAINT "RangeInstance_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "PlatformUser"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "SingleInstanceBatch"
ADD CONSTRAINT "SingleInstanceBatch_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "PlatformUser"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
