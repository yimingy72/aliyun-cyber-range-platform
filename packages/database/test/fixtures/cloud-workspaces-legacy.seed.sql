BEGIN;
DO $$ BEGIN
 ASSERT (SELECT count(*) FROM "PlatformUser" WHERE "id"<>'admin')=0, 'Migration smoke requires an empty disposable database';
 ASSERT (SELECT count(*) FROM "CloudAccountContext")=0, 'Migration smoke requires no configured cloud credentials';
 ASSERT (SELECT count(*) FROM "RangeInstance")=0, 'Migration smoke requires no existing resources';
END $$;
INSERT INTO "PlatformUser" ("id","username","passwordHash","role","updatedAt") VALUES
 ('admin','fixture-admin','synthetic-fixture','admin',CURRENT_TIMESTAMP),
 ('fixture-alice','alice','synthetic-fixture','user',CURRENT_TIMESTAMP),
 ('fixture-bob','bob','synthetic-fixture','user',CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET "username"=EXCLUDED."username","passwordHash"=EXCLUDED."passwordHash","role"=EXCLUDED."role";
INSERT INTO "CloudAccountContext" ("id","displayName","provider","accountUid","regionId","zoneId","accessKeyId","accessKeySecret","imageImportBucket","isActive","status","updatedAt") VALUES
 ('fixture-ali-a','Fixture Alibaba A','alibaba_cloud','100001','cn-hangzhou','cn-hangzhou-h','synthetic-fixture-id','synthetic-fixture-secret','',true,'ready',CURRENT_TIMESTAMP),
 ('fixture-ali-b','Fixture Alibaba B','alibaba_cloud','100002','cn-hangzhou','cn-hangzhou-h','synthetic-fixture-id','synthetic-fixture-secret','',false,'ready',CURRENT_TIMESTAMP),
 ('fixture-tencent','Fixture Tencent','tencent_cloud','200001','ap-nanjing','ap-nanjing-1','synthetic-fixture-id','synthetic-fixture-secret','',false,'ready',CURRENT_TIMESTAMP);
INSERT INTO "CloudImageSnapshot" ("id","provider","accountUid","accountScopeKey","regionId","scope","imageId","sourceImageName","lastSyncedAt","updatedAt") VALUES
 ('fixture-image-ali','alibaba_cloud','100001','100001','cn-hangzhou','custom','fixture-cloud-image-a','Fixture Alibaba',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('fixture-image-tencent','tencent_cloud','200001','200001','ap-nanjing','custom','fixture-cloud-image-t','Fixture Tencent',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('fixture-image-unknown','alibaba_cloud',NULL,'__unscoped__','cn-hangzhou','custom','fixture-unknown-image','Unknown source',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('fixture-public-image','alibaba_cloud',NULL,'__unscoped__','cn-hangzhou','public','fixture-public','Public metadata',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "PlatformImageAsset" ("id","provider","accountUid","accountScopeKey","regionId","sourceScope","sourceSnapshotId","imageId","displayName","ownerUserId","updatedAt") VALUES
 ('fixture-asset-ali','alibaba_cloud','100001','100001','cn-hangzhou','custom','fixture-image-ali','fixture-cloud-image-a','Fixture Alibaba','fixture-alice',CURRENT_TIMESTAMP),
 ('fixture-asset-tencent','tencent_cloud','200001','200001','ap-nanjing','custom','fixture-image-tencent','fixture-cloud-image-t','Fixture Tencent','fixture-bob',CURRENT_TIMESTAMP);
INSERT INTO "CloudImageSnapshot" ("id","provider","accountUid","accountScopeKey","regionId","scope","imageId","sourceImageName","lastSyncedAt","updatedAt") VALUES
 ('fixture-import-source','alibaba_cloud',NULL,'__unscoped__','cn-hangzhou','custom','fixture-cloud-import-image','Imported source',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "PlatformImageAsset" ("id","provider","accountUid","accountScopeKey","regionId","sourceScope","sourceSnapshotId","imageId","displayName","ownerUserId","updatedAt") VALUES
 ('fixture-import-asset','alibaba_cloud',NULL,'__unscoped__','cn-hangzhou','custom','fixture-import-source','fixture-cloud-import-image','Imported source','fixture-alice',CURRENT_TIMESTAMP),
 ('fixture-conflicting-asset','alibaba_cloud','100001','100001','cn-hangzhou','custom','fixture-image-tencent','fixture-conflicting-image','Conflicting catalog source','fixture-alice',CURRENT_TIMESTAMP);
INSERT INTO "ImageCatalogItem" ("id","displayName","imageId","provider","scope","accountUid","accountScopeKey","regionId","sourceSnapshotId","updatedAt") VALUES
 ('fixture-import-catalog','Imported catalog','fixture-cloud-import-image','alibaba_cloud','custom',NULL,'__unscoped__','cn-hangzhou','fixture-import-source',CURRENT_TIMESTAMP);
INSERT INTO "ImageImportJob" ("id","cloudAccountContextId","cloudAccountUid","regionId","ownerUserId","displayName","osType","architecture","bootMode","imageFormat","systemDiskSize","sourceFileName","sourceContentType","sourceSizeBytes","objectKey","uploadExpiresAt","status","imageId","sourceSnapshotId","platformImageAssetId","updatedAt") VALUES
 ('fixture-import','fixture-ali-a','100001','cn-hangzhou','fixture-alice','Imported fixture','linux','x86_64','BIOS','RAW',40,'fixture.raw','application/octet-stream','1','synthetic-object','2030-01-01','available','fixture-cloud-import-image','fixture-import-source','fixture-import-asset',CURRENT_TIMESTAMP);
INSERT INTO "RangeTemplate" ("id","name","slug","version","modulePathOrRef","variableSchema","outputSchema","ownerUserId","updatedAt") VALUES
 ('fixture-template','Fixture template','fixture-template','1','fixture','{}','{}','fixture-alice',CURRENT_TIMESTAMP);
INSERT INTO "RangeInstance" ("id","name","ownerUserId","templateId","status","instanceMode","cloudProvider","singleInstanceConfig","updatedAt") VALUES
 ('fixture-single-a','Alibaba source','fixture-alice','fixture-template','running','single','alibaba_cloud','{"cloudAccountUid":"100001","cloudAccountContextId":"fixture-ali-a","regionId":"cn-hangzhou","instanceId":"synthetic-instance-a"}',CURRENT_TIMESTAMP),
 ('fixture-single-t','Tencent source','fixture-bob',NULL,'destroyed','single','tencent_cloud','{"cloudAccountUid":"200001","cloudAccountContextId":"fixture-tencent","regionId":"ap-nanjing","instanceId":"synthetic-instance-t"}',CURRENT_TIMESTAMP),
 ('fixture-single-unbound','Unbound history','fixture-alice',NULL,'create_failed','single','alibaba_cloud','{"instanceId":"synthetic-unbound-instance"}',CURRENT_TIMESTAMP),
 ('fixture-single-conflict','Conflicting history','fixture-alice',NULL,'destroy_failed','single','alibaba_cloud','{"cloudAccountUid":"100001","cloudAccountContextId":"fixture-ali-b","regionId":"cn-hangzhou"}',CURRENT_TIMESTAMP),
 ('fixture-destroyed','Cleared runtime history','fixture-alice',NULL,'destroyed','range','alibaba_cloud',NULL,CURRENT_TIMESTAMP);
INSERT INTO "ProvisionJob" ("id","rangeInstanceId","jobType","status","triggeredBy","updatedAt") VALUES
 ('fixture-job-a','fixture-single-a','create','succeeded','fixture-alice',CURRENT_TIMESTAMP),
 ('fixture-job-conflict','fixture-single-conflict','destroy','failed','fixture-alice',CURRENT_TIMESTAMP);
INSERT INTO "BillingLedgerResource" ("id","cloudProvider","cloudAccountUid","regionId","cloudResourceId","cloudResourceType","billingScope","ownerUserId","rangeInstanceId","sourceProvisionJobId","billingStartAt","updatedAt") VALUES
 ('fixture-ledger-a','alibaba_cloud','100001','cn-hangzhou','synthetic-instance-a','ecs','user','fixture-alice','fixture-single-a','fixture-job-a',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('fixture-ledger-destroyed','alibaba_cloud','100001','cn-hangzhou','synthetic-destroyed-instance','ecs','user','fixture-alice','fixture-destroyed',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "OperationAuditEvent" ("id","operationId","requestId","actorUserId","source","toolName","phase","jobId") VALUES
 ('fixture-audit','fixture-operation','fixture-request','admin','web','fixture_launch','succeeded','fixture-job-a');
COMMIT;
