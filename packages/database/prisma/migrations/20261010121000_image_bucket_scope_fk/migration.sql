CREATE UNIQUE INDEX "CloudImageImportBucket_cloudWorkspaceId_id_key" ON "CloudImageImportBucket"("cloudWorkspaceId", "id");
ALTER TABLE "ImageImportJob" ADD CONSTRAINT "ImageImportJob_cloudWorkspaceId_managedBucketId_fkey" FOREIGN KEY ("cloudWorkspaceId", "managedBucketId") REFERENCES "CloudImageImportBucket"("cloudWorkspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
