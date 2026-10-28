CREATE TABLE "PlatformContainerImage" (
  "id" TEXT NOT NULL,
  "cloudWorkspaceId" TEXT NOT NULL,
  "sourceId" INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "creator" TEXT,
  "imageReference" TEXT,
  "referenceStatus" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformContainerImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformContainerImage_sourceId_check" CHECK ("sourceId" > 0),
  CONSTRAINT "PlatformContainerImage_referenceStatus_check" CHECK ("referenceStatus" IN ('recorded', 'needs_review')),
  CONSTRAINT "PlatformContainerImage_workspace_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformContainerImage_cloudWorkspaceId_sourceId_key" ON "PlatformContainerImage"("cloudWorkspaceId", "sourceId");
CREATE INDEX "PlatformContainerImage_cloudWorkspaceId_createdAt_idx" ON "PlatformContainerImage"("cloudWorkspaceId", "createdAt");
CREATE TRIGGER "PlatformContainerImage_workspace_immutable" BEFORE UPDATE ON "PlatformContainerImage" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"();
