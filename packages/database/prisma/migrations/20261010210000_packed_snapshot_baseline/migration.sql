ALTER TABLE "PackedImageArtifact" ADD COLUMN "sourceSnapshotBaseline" JSONB;

CREATE FUNCTION "guard_packed_snapshot_baseline"() RETURNS TRIGGER AS $$
DECLARE value JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."sourceSnapshotBaseline" IS DISTINCT FROM NEW."sourceSnapshotBaseline" THEN
    RAISE EXCEPTION 'Packed snapshot baseline cannot be added, replaced or cleared after artifact insertion';
  END IF;
  value := NEW."sourceSnapshotBaseline";
  IF value IS NOT NULL THEN
    IF jsonb_typeof(value) <> 'object' OR NEW."cloudProvider" <> 'tencent_cloud'
      OR value->>'kind' IS DISTINCT FROM 'native_tencent_pack_snapshot_baseline_v1'
      OR value->>'id' IS DISTINCT FROM NEW.id
      OR value->>'cloudProvider' IS DISTINCT FROM NEW."cloudProvider"::TEXT
      OR value->>'cloudWorkspaceId' IS DISTINCT FROM NEW."cloudWorkspaceId"
      OR value->>'cloudAccountContextId' IS DISTINCT FROM NEW."cloudAccountContextId"
      OR value->>'cloudAccountUid' IS DISTINCT FROM NEW."cloudAccountUid"
      OR value->>'regionId' IS DISTINCT FROM NEW."regionId"
      OR value->>'ownerUserId' IS DISTINCT FROM NEW."ownerUserId"
      OR value->>'sourceRangeInstanceId' IS DISTINCT FROM NEW."sourceRangeInstanceId"
      OR value->>'sourceHostKey' IS DISTINCT FROM NEW."sourceHostKey"
      OR value->>'sourceInstanceId' IS DISTINCT FROM NEW."sourceInstanceId"
      OR jsonb_typeof(value->'sourceDiskIds') IS DISTINCT FROM 'array'
      OR NOT ((value->'sourceDiskIds') @> NEW."sourceDiskIds" AND NEW."sourceDiskIds" @> (value->'sourceDiskIds')) THEN
      RAISE EXCEPTION 'Packed snapshot baseline differs from immutable creation identity';
    END IF;
    IF TG_OP = 'INSERT' AND (NEW.status <> 'pending' OR NEW."imageId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Packed snapshot baseline must precede native submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PackedImageArtifact_snapshot_baseline_immutable"
BEFORE INSERT OR UPDATE ON "PackedImageArtifact"
FOR EACH ROW EXECUTE FUNCTION "guard_packed_snapshot_baseline"();
