ALTER TABLE "CloudWorkspace" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Resource admission holds a shared row lock until commit. Unbinding cannot
-- race a request that already resolved its workspace before deletion.
CREATE FUNCTION reject_archived_cloud_resource_admission() RETURNS trigger AS $$
DECLARE archived TIMESTAMP(3);
BEGIN
  SELECT "archivedAt" INTO archived FROM "CloudWorkspace"
    WHERE id = NEW."cloudWorkspaceId" FOR SHARE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'Cloud account binding was deleted; rebind before creating resources'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "RangeInstance"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "ProvisionJob"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "ImageImportJob"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "PackedImageArtifact"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "CloudImageImportBucket"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
CREATE TRIGGER cloud_account_admission BEFORE INSERT OR UPDATE ON "SingleInstanceNetworkProfile"
  FOR EACH ROW EXECUTE FUNCTION reject_archived_cloud_resource_admission();
