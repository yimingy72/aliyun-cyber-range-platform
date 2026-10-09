DO $$ DECLARE ali text; tencent text; BEGIN
 SELECT "cloudWorkspaceId" INTO ali FROM "CloudAccountContext" WHERE "id"='fixture-ali-a';
 SELECT "cloudWorkspaceId" INTO tencent FROM "CloudAccountContext" WHERE "id"='fixture-tencent';
 ASSERT ali<>tencent;
 ASSERT (SELECT "accountUid"='100001' AND "provider"='alibaba_cloud' AND NOT "isReadOnly" FROM "CloudWorkspace" WHERE "id"=ali);
 ASSERT (SELECT "accountUid"='200001' AND "provider"='tencent_cloud' AND NOT "isReadOnly" FROM "CloudWorkspace" WHERE "id"=tencent);
 ASSERT (SELECT "accountUid" IS NULL AND "isReadOnly" FROM "CloudWorkspace" WHERE "id"='legacy-unbound');
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "RangeInstance" WHERE "id"='fixture-single-a');
 ASSERT (SELECT "cloudWorkspaceId"=tencent FROM "RangeInstance" WHERE "id"='fixture-single-t');
 ASSERT (SELECT "cloudWorkspaceId"='legacy-unbound' FROM "RangeInstance" WHERE "id"='fixture-single-unbound');
 ASSERT (SELECT "cloudWorkspaceId"='legacy-unbound' FROM "RangeInstance" WHERE "id"='fixture-single-conflict');
 ASSERT (SELECT "singleInstanceConfig"->>'cloudAccountContextId'='fixture-ali-b' FROM "RangeInstance" WHERE "id"='fixture-single-conflict'), 'Do not rewrite cloud source evidence';
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "RangeInstance" WHERE "id"='fixture-destroyed');
 ASSERT (SELECT "cloudWorkspaceId"=ali AND "ownerUserId"='fixture-alice' AND "sourceProvisionJobId"='fixture-job-a' FROM "BillingLedgerResource" WHERE "id"='fixture-ledger-a');
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "RangeTemplate" WHERE "id"='fixture-template');
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "CloudImageSnapshot" WHERE "id"='fixture-public-image');
 ASSERT (SELECT "cloudWorkspaceId"='legacy-unbound' FROM "CloudImageSnapshot" WHERE "id"='fixture-image-unknown');
 ASSERT (SELECT "cloudWorkspaceId"=tencent FROM "PlatformImageAsset" WHERE "id"='fixture-asset-tencent');
 ASSERT (SELECT "cloudWorkspaceId"=ali AND "accountUid" IS NULL FROM "CloudImageSnapshot" WHERE "id"='fixture-import-source');
 ASSERT (SELECT "cloudWorkspaceId"=ali AND "accountUid" IS NULL FROM "PlatformImageAsset" WHERE "id"='fixture-import-asset');
 ASSERT (SELECT "cloudWorkspaceId"=ali AND "accountUid" IS NULL FROM "ImageCatalogItem" WHERE "id"='fixture-import-catalog');
 ASSERT (SELECT "cloudWorkspaceId"='legacy-unbound' FROM "PlatformImageAsset" WHERE "id"='fixture-conflicting-asset');
 ASSERT (SELECT "ownerUserId"='fixture-alice' AND "sourceSnapshotId"='fixture-import-source' AND "platformImageAssetId"='fixture-import-asset' FROM "ImageImportJob" WHERE "id"='fixture-import');

 ASSERT (SELECT "cloudWorkspaceId"=ali AND "loginUsername"='alice' AND NOT "isPlatformManager" FROM "PlatformUser" WHERE "id"='fixture-alice');
 ASSERT (SELECT "cloudWorkspaceId"=tencent AND "loginUsername"='bob' FROM "PlatformUser" WHERE "id"='fixture-bob');
 ASSERT (SELECT "cloudWorkspaceId" IS NULL AND "selectedCloudWorkspaceId"=ali AND "loginUsername"='fixture-admin' AND "isPlatformManager" FROM "PlatformUser" WHERE "id"='admin');
 ASSERT (SELECT "cloudWorkspaceId"=ali AND "actorUserId"='admin' AND "jobId"='fixture-job-a' FROM "OperationAuditEvent" WHERE "id"='fixture-audit');
 ASSERT (SELECT "cloudWorkspaceId"='legacy-unbound' FROM "ProvisionJob" WHERE "id"='fixture-job-conflict');
 ASSERT (SELECT count(*) FROM "RangeInstance")=5, 'History must not be deleted';
END $$;
DO $$ DECLARE ali text; tencent text; BEGIN
 SELECT "cloudWorkspaceId" INTO ali FROM "CloudAccountContext" WHERE "id"='fixture-ali-a';
 SELECT "cloudWorkspaceId" INTO tencent FROM "CloudAccountContext" WHERE "id"='fixture-tencent';
 BEGIN
  INSERT INTO "CloudWorkspace" ("id","provider","accountUid","displayName","updatedAt") VALUES ('fixture-invalid-null','alibaba_cloud',NULL,'Invalid',CURRENT_TIMESTAMP);
  RAISE EXCEPTION 'A configured cloud workspace cannot have an unknown account UID';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "CloudWorkspace" SET "isReadOnly"=false WHERE "id"='legacy-unbound';
  RAISE EXCEPTION 'Unbound history cannot become writable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "PlatformUser" ("id","username","loginUsername","passwordHash","updatedAt") VALUES ('fixture-invalid-user','invalid','invalid','synthetic-fixture',CURRENT_TIMESTAMP);
  RAISE EXCEPTION 'A business user cannot become global through a null workspace';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "PlatformUser" SET "cloudWorkspaceId"=tencent WHERE "id"='fixture-alice';
  RAISE EXCEPTION 'An existing user cannot move to another cloud account';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "CloudImageSnapshot" SET "cloudWorkspaceId"=tencent WHERE "id"='fixture-image-ali';
  RAISE EXCEPTION 'A cloud resource cannot change its source workspace';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "RangeInstance" ("id","name","cloudWorkspaceId","ownerUserId","updatedAt") VALUES ('fixture-cross-owner','Invalid owner',ali,'fixture-bob',CURRENT_TIMESTAMP);
  RAISE EXCEPTION 'New resources cannot use another account business user';
 EXCEPTION WHEN check_violation THEN NULL; END;
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "PlatformUser" WHERE "id"='fixture-alice');
 ASSERT (SELECT "cloudWorkspaceId"=ali FROM "CloudImageSnapshot" WHERE "id"='fixture-image-ali');
END $$;
