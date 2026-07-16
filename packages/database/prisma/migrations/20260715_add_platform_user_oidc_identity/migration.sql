-- AlterTable
ALTER TABLE "PlatformUser"
ADD COLUMN "oidcIssuer" TEXT,
ADD COLUMN "oidcSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_oidcIssuer_oidcSubject_key" ON "PlatformUser"("oidcIssuer", "oidcSubject");
