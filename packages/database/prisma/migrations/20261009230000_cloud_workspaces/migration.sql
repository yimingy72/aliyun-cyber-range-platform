BEGIN;

-- DropIndex
DROP INDEX IF EXISTS "PlatformUser_username_key";

-- DropIndex
DROP INDEX IF EXISTS "IdempotentOperation_actorUserId_toolName_idempotencyKey_key";

-- DropIndex
DROP INDEX IF EXISTS "CloudImageSnapshot_provider_accountScopeKey_regionId_scope__key";

-- DropIndex
DROP INDEX IF EXISTS "ImageImportJob_objectKey_key";

-- DropIndex
DROP INDEX IF EXISTS "ImageImportJob_imageId_key";

-- DropIndex
DROP INDEX IF EXISTS "PackedImageArtifact_imageId_key";

-- DropIndex
DROP INDEX IF EXISTS "ImageCatalogItem_provider_accountScopeKey_regionId_scope_im_key";

-- DropIndex
DROP INDEX IF EXISTS "PlatformImageAsset_provider_accountScopeKey_regionId_imageI_key";

-- DropIndex
DROP INDEX IF EXISTS "PlatformImageTag_normalizedName_key";

-- DropIndex
DROP INDEX IF EXISTS "RangeTemplate_slug_version_key";

-- DropIndex
DROP INDEX IF EXISTS "SingleInstanceNetworkProfile_provider_cloudAccountUid_regio_key";

-- DropIndex
DROP INDEX IF EXISTS "CloudResourceDrift_cloudProvider_regionId_cloudResourceType_key";

-- DropIndex
DROP INDEX IF EXISTS "BillingLedgerResource_cloudProvider_regionId_cloudResourceI_key";

-- DropIndex
DROP INDEX IF EXISTS "BillingLineItem_sourceFingerprint_key";

-- DropIndex
DROP INDEX IF EXISTS "BillingAnomaly_sourceFingerprint_key";

DROP INDEX IF EXISTS "CloudImageSnapshot_provider_accountScopeKey_regionId_scope_imageId_key";
DROP INDEX IF EXISTS "ImageCatalogItem_provider_accountScopeKey_regionId_scope_imageId_key";
DROP INDEX IF EXISTS "PlatformImageAsset_provider_accountScopeKey_regionId_imageId_key";
DROP INDEX IF EXISTS "SingleInstanceNetworkProfile_provider_cloudAccountUid_regionId_zoneId_key";
DROP INDEX IF EXISTS "CloudResourceDrift_cloudProvider_regionId_cloudResourceType_cloudResourceId_key";
DROP INDEX IF EXISTS "BillingLedgerResource_cloudProvider_regionId_cloudResourceId_cloudResourceType_key";

-- AlterTable
ALTER TABLE "CloudAccountContext" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "PlatformUser" ADD COLUMN     "cloudWorkspaceId" TEXT,
ADD COLUMN     "isPlatformManager" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "loginUsername" TEXT,
ADD COLUMN     "selectedCloudWorkspaceId" TEXT;

-- AlterTable
ALTER TABLE "OperationConfirmation" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "IdempotentOperation" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "OperationAuditEvent" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "CloudImageSnapshot" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "ImageImportJob" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "PackedImageArtifact" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "ImageCatalogItem" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "PlatformImageAsset" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "PlatformImageTag" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "PlatformImageAssetTag" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "RangeTemplate" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "RangeTemplateVersion" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "SingleInstanceBatch" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "RangeInstance" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "SingleInstanceNetworkProfile" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "ProvisionJob" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "ProvisionJobStepLog" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "CloudResourceDrift" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "BillingLedgerResource" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "BillingLineItem" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- AlterTable
ALTER TABLE "BillingAnomaly" ADD COLUMN     "cloudWorkspaceId" TEXT NOT NULL DEFAULT 'legacy-unbound';

-- CreateTable
CREATE TABLE "CloudWorkspace" (
    "id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "accountUid" TEXT,
    "displayName" TEXT NOT NULL,
    "isReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "activeCloudAccountContextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudWorkspace_pkey" PRIMARY KEY ("id")
);


-- Account identities and frozen resource sources determine cloud workspaces.
-- The legacy data workspace is deliberately read-only and has no cloud credentials.
INSERT INTO "CloudWorkspace" ("id","provider","accountUid","displayName","isReadOnly","updatedAt")
VALUES ('legacy-unbound','alibaba_cloud',NULL,'历史未绑定来源',true,CURRENT_TIMESTAMP);
WITH sources AS (
 SELECT "provider", "accountUid" FROM "CloudAccountContext"
 UNION SELECT "provider", "accountUid" FROM "CloudImageSnapshot"
 UNION SELECT "provider", "accountUid" FROM "PlatformImageAsset"
 UNION SELECT "cloudProvider", "cloudAccountUid" FROM "BillingLedgerResource"
 UNION SELECT 'alibaba_cloud'::"CloudProvider", "cloudAccountUid" FROM "ImageImportJob"
 UNION SELECT 'alibaba_cloud'::"CloudProvider", "cloudAccountUid" FROM "PackedImageArtifact"
 UNION SELECT "provider", "cloudAccountUid" FROM "SingleInstanceNetworkProfile"
 UNION SELECT "cloudProvider", "singleInstanceConfig"->>'cloudAccountUid' FROM "RangeInstance"
 UNION SELECT "cloudProvider", "resourceSummary"->'executionContext'->>'cloudAccountUid' FROM "RangeInstance"
)
INSERT INTO "CloudWorkspace" ("id","provider","accountUid","displayName","isReadOnly","createdAt","updatedAt")
SELECT 'cloud-ws-'||md5(s."provider"::text||':'||s."accountUid"),s."provider",s."accountUid",
 (CASE s."provider" WHEN 'alibaba_cloud' THEN '阿里云 ' ELSE '腾讯云 ' END)||s."accountUid",
 NOT EXISTS (SELECT 1 FROM "CloudAccountContext" c WHERE c."provider"=s."provider" AND c."accountUid"=s."accountUid" AND c."status"='ready'),
 CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM sources s WHERE s."accountUid" ~ '^[0-9]{1,32}$'
ON CONFLICT ("id") DO NOTHING;
UPDATE "CloudAccountContext" c SET "cloudWorkspaceId"=w."id"
FROM "CloudWorkspace" w WHERE w."provider"=c."provider" AND w."accountUid"=c."accountUid";
UPDATE "CloudWorkspace" w SET "activeCloudAccountContextId"=(
 SELECT c."id" FROM "CloudAccountContext" c WHERE c."cloudWorkspaceId"=w."id" AND c."status"='ready'
 ORDER BY c."isActive" DESC,c."updatedAt" DESC,c."id" LIMIT 1
) WHERE w."accountUid" IS NOT NULL;
CREATE TEMP TABLE "_workspace_primary" AS
 SELECT COALESCE((SELECT min("cloudWorkspaceId") FROM "CloudAccountContext"
 WHERE "provider"='alibaba_cloud' AND "isActive"=true
 HAVING count(DISTINCT "cloudWorkspaceId")=1),'legacy-unbound') AS "id";
CREATE TEMP TABLE "_workspace_assignments" ("entity" text,"id" text,"workspaceId" text);
INSERT INTO "_workspace_assignments" SELECT 'CloudImageSnapshot',r."id",w."id" FROM "CloudImageSnapshot" r JOIN "CloudWorkspace" w ON w."provider"=r."provider" AND w."accountUid"=r."accountUid" AND w."accountUid" IS NOT NULL;
UPDATE "CloudImageSnapshot" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "CloudImageSnapshot" r LEFT JOIN "_workspace_assignments" a ON a."entity"='CloudImageSnapshot' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'PlatformImageAsset',r."id",w."id" FROM "PlatformImageAsset" r JOIN "CloudWorkspace" w ON w."provider"=r."provider" AND w."accountUid"=r."accountUid" AND w."accountUid" IS NOT NULL;
UPDATE "PlatformImageAsset" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "PlatformImageAsset" r LEFT JOIN "_workspace_assignments" a ON a."entity"='PlatformImageAsset' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'ImageCatalogItem',r."id",w."id" FROM "ImageCatalogItem" r JOIN "CloudWorkspace" w ON w."provider"=r."provider" AND w."accountUid"=r."accountUid" AND w."accountUid" IS NOT NULL;
UPDATE "ImageCatalogItem" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "ImageCatalogItem" r LEFT JOIN "_workspace_assignments" a ON a."entity"='ImageCatalogItem' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
UPDATE "CloudImageSnapshot" SET "cloudWorkspaceId"=(SELECT "id" FROM "_workspace_primary") WHERE "scope"='public' AND "accountUid" IS NULL;
UPDATE "ImageCatalogItem" SET "cloudWorkspaceId"=(SELECT "id" FROM "_workspace_primary") WHERE "scope"='public' AND "accountUid" IS NULL;
UPDATE "PlatformImageAsset" SET "cloudWorkspaceId"=(SELECT "id" FROM "_workspace_primary") WHERE "sourceScope"='public' AND "accountUid" IS NULL;
INSERT INTO "_workspace_assignments" SELECT 'ImageImportJob',r."id",w."id" FROM "ImageImportJob" r JOIN "CloudWorkspace" w ON w."provider"='alibaba_cloud'::"CloudProvider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'ImageImportJob',r."id",p."cloudWorkspaceId" FROM "ImageImportJob" r JOIN "CloudAccountContext" p ON r."cloudAccountContextId"=p."id";
UPDATE "ImageImportJob" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "ImageImportJob" r LEFT JOIN "_workspace_assignments" a ON a."entity"='ImageImportJob' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'PackedImageArtifact',r."id",w."id" FROM "PackedImageArtifact" r JOIN "CloudWorkspace" w ON w."provider"='alibaba_cloud'::"CloudProvider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'PackedImageArtifact',r."id",p."cloudWorkspaceId" FROM "PackedImageArtifact" r JOIN "CloudAccountContext" p ON r."cloudAccountContextId"=p."id";
UPDATE "PackedImageArtifact" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "PackedImageArtifact" r LEFT JOIN "_workspace_assignments" a ON a."entity"='PackedImageArtifact' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'SingleInstanceNetworkProfile',r."id",w."id" FROM "SingleInstanceNetworkProfile" r JOIN "CloudWorkspace" w ON w."provider"=r."provider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'SingleInstanceNetworkProfile',r."id",p."cloudWorkspaceId" FROM "SingleInstanceNetworkProfile" r JOIN "CloudAccountContext" p ON r."cloudAccountContextId"=p."id";
UPDATE "SingleInstanceNetworkProfile" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "SingleInstanceNetworkProfile" r LEFT JOIN "_workspace_assignments" a ON a."entity"='SingleInstanceNetworkProfile' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'BillingLedgerResource',r."id",w."id" FROM "BillingLedgerResource" r JOIN "CloudWorkspace" w ON w."provider"=r."cloudProvider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
UPDATE "BillingLedgerResource" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "BillingLedgerResource" r LEFT JOIN "_workspace_assignments" a ON a."entity"='BillingLedgerResource' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'RangeInstance',r."id",w."id" FROM "RangeInstance" r JOIN "CloudWorkspace" w ON w."provider"=r."cloudProvider" AND w."accountUid"=r."singleInstanceConfig"->>'cloudAccountUid' AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'RangeInstance',r."id",w."id" FROM "RangeInstance" r JOIN "CloudWorkspace" w ON w."provider"=r."cloudProvider" AND w."accountUid"=r."resourceSummary"->'executionContext'->>'cloudAccountUid' AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'RangeInstance',r."id",c."cloudWorkspaceId" FROM "RangeInstance" r JOIN "CloudAccountContext" c ON c."id"=COALESCE(r."singleInstanceConfig"->>'cloudAccountContextId',r."resourceSummary"->'executionContext'->>'cloudAccountContextId');
INSERT INTO "_workspace_assignments" SELECT 'RangeInstance',r."id",l."cloudWorkspaceId" FROM "RangeInstance" r JOIN "BillingLedgerResource" l ON l."rangeInstanceId"=r."id" WHERE l."cloudWorkspaceId"<>'legacy-unbound';
UPDATE "RangeInstance" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "RangeInstance" r LEFT JOIN "_workspace_assignments" a ON a."entity"='RangeInstance' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'ProvisionJob',r."id",p."cloudWorkspaceId" FROM "ProvisionJob" r JOIN "RangeInstance" p ON r."rangeInstanceId"=p."id";
UPDATE "ProvisionJob" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "ProvisionJob" r LEFT JOIN "_workspace_assignments" a ON a."entity"='ProvisionJob' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'ProvisionJobStepLog',r."id",p."cloudWorkspaceId" FROM "ProvisionJobStepLog" r JOIN "ProvisionJob" p ON r."jobId"=p."id";
UPDATE "ProvisionJobStepLog" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "ProvisionJobStepLog" r LEFT JOIN "_workspace_assignments" a ON a."entity"='ProvisionJobStepLog' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'SingleInstanceBatch',b."id",r."cloudWorkspaceId" FROM "SingleInstanceBatch" b JOIN "RangeInstance" r ON r."singleInstanceBatchId"=b."id";
UPDATE "SingleInstanceBatch" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "SingleInstanceBatch" r LEFT JOIN "_workspace_assignments" a ON a."entity"='SingleInstanceBatch' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'RangeTemplate',t."id",r."cloudWorkspaceId" FROM "RangeTemplate" t JOIN "RangeInstance" r ON r."templateId"=t."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT DISTINCT 'RangeTemplate',t."id",a."cloudWorkspaceId" FROM "RangeTemplate" t
 JOIN "PlatformImageAsset" a ON a."provider"=t."cloudProvider"
 AND (jsonb_path_query_array(COALESCE(t."topologyGraph",'{}'::jsonb),'$.**.platformImageAssetId') @> jsonb_build_array(a."id") OR jsonb_path_query_array(COALESCE(t."topologyGraph",'{}'::jsonb),'$.**.imageId') @> jsonb_build_array(a."imageId"))
 WHERE a."cloudWorkspaceId"<>'legacy-unbound';
UPDATE "RangeTemplate" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "RangeTemplate" r LEFT JOIN "_workspace_assignments" a ON a."entity"='RangeTemplate' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'RangeTemplateVersion',r."id",p."cloudWorkspaceId" FROM "RangeTemplateVersion" r JOIN "RangeTemplate" p ON r."templateId"=p."id";
UPDATE "RangeTemplateVersion" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "RangeTemplateVersion" r LEFT JOIN "_workspace_assignments" a ON a."entity"='RangeTemplateVersion' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'PlatformImageTag',t."id",a."cloudWorkspaceId" FROM "PlatformImageTag" t JOIN "PlatformImageAssetTag" j ON j."tagId"=t."id" JOIN "PlatformImageAsset" a ON a."id"=j."platformImageAssetId";
UPDATE "PlatformImageTag" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "PlatformImageTag" r LEFT JOIN "_workspace_assignments" a ON a."entity"='PlatformImageTag' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
UPDATE "PlatformImageAssetTag" j SET "cloudWorkspaceId"=CASE WHEN a."cloudWorkspaceId"=t."cloudWorkspaceId" THEN a."cloudWorkspaceId" ELSE 'legacy-unbound' END
 FROM "PlatformImageAsset" a,"PlatformImageTag" t WHERE a."id"=j."platformImageAssetId" AND t."id"=j."tagId";
INSERT INTO "_workspace_assignments" SELECT 'BillingLineItem',r."id",w."id" FROM "BillingLineItem" r JOIN "CloudWorkspace" w ON w."provider"='alibaba_cloud'::"CloudProvider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'BillingLineItem',r."id",p."cloudWorkspaceId" FROM "BillingLineItem" r JOIN "BillingLedgerResource" p ON r."matchedLedgerId"=p."id";
UPDATE "BillingLineItem" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "BillingLineItem" r LEFT JOIN "_workspace_assignments" a ON a."entity"='BillingLineItem' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'BillingAnomaly',r."id",w."id" FROM "BillingAnomaly" r JOIN "CloudWorkspace" w ON w."provider"='alibaba_cloud'::"CloudProvider" AND w."accountUid"=r."cloudAccountUid" AND w."accountUid" IS NOT NULL;
UPDATE "BillingAnomaly" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "BillingAnomaly" r LEFT JOIN "_workspace_assignments" a ON a."entity"='BillingAnomaly' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'CloudResourceDrift',r."id",p."cloudWorkspaceId" FROM "CloudResourceDrift" r JOIN "RangeInstance" p ON r."rangeInstanceId"=p."id";
UPDATE "CloudResourceDrift" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE 'legacy-unbound' END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "CloudResourceDrift" r LEFT JOIN "_workspace_assignments" a ON a."entity"='CloudResourceDrift' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "PlatformImageAsset" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "RangeTemplate" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "RangeInstance" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "SingleInstanceBatch" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "ImageImportJob" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "PackedImageArtifact" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
INSERT INTO "_workspace_assignments" SELECT 'PlatformUser',u."id",r."cloudWorkspaceId" FROM "PlatformUser" u JOIN "BillingLedgerResource" r ON r."ownerUserId"=u."id" WHERE r."cloudWorkspaceId"<>'legacy-unbound';
UPDATE "PlatformUser" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "PlatformUser" r LEFT JOIN "_workspace_assignments" a ON a."entity"='PlatformUser' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
UPDATE "PlatformUser" SET "loginUsername"="username";
UPDATE "PlatformUser" SET "isPlatformManager"=true,"cloudWorkspaceId"=NULL,
 "selectedCloudWorkspaceId"=(SELECT "id" FROM "_workspace_primary") WHERE "id"='admin' AND "role"='admin';
ALTER TABLE "PlatformUser" ALTER COLUMN "loginUsername" SET NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'OperationConfirmation',r."id",u."cloudWorkspaceId" FROM "OperationConfirmation" r JOIN "PlatformUser" u ON u."id"=r."actorUserId" WHERE u."cloudWorkspaceId" IS NOT NULL;
UPDATE "OperationConfirmation" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "OperationConfirmation" r LEFT JOIN "_workspace_assignments" a ON a."entity"='OperationConfirmation' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'IdempotentOperation',r."id",u."cloudWorkspaceId" FROM "IdempotentOperation" r JOIN "PlatformUser" u ON u."id"=r."actorUserId" WHERE u."cloudWorkspaceId" IS NOT NULL;
UPDATE "IdempotentOperation" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "IdempotentOperation" r LEFT JOIN "_workspace_assignments" a ON a."entity"='IdempotentOperation' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";
INSERT INTO "_workspace_assignments" SELECT 'OperationAuditEvent',r."id",u."cloudWorkspaceId" FROM "OperationAuditEvent" r JOIN "PlatformUser" u ON u."id"=r."actorUserId" WHERE u."cloudWorkspaceId" IS NOT NULL;
INSERT INTO "_workspace_assignments" SELECT 'OperationAuditEvent',r."id",p."cloudWorkspaceId" FROM "OperationAuditEvent" r JOIN "ProvisionJob" p ON r."jobId"=p."id";
UPDATE "OperationAuditEvent" r SET "cloudWorkspaceId"=CASE
 WHEN a."count"=1 THEN a."workspaceId" WHEN a."count">1 THEN 'legacy-unbound' ELSE (SELECT "id" FROM "_workspace_primary") END
 FROM (SELECT r."id",count(DISTINCT a."workspaceId") AS "count",min(a."workspaceId") AS "workspaceId"
 FROM "OperationAuditEvent" r LEFT JOIN "_workspace_assignments" a ON a."entity"='OperationAuditEvent' AND a."id"=r."id" GROUP BY r."id") a WHERE a."id"=r."id";

-- CreateIndex
CREATE UNIQUE INDEX "CloudWorkspace_provider_accountUid_key" ON "CloudWorkspace"("provider", "accountUid");

-- CreateIndex
CREATE INDEX "CloudAccountContext_cloudWorkspaceId_idx" ON "CloudAccountContext"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_loginUsername_key" ON "PlatformUser"("loginUsername");

-- CreateIndex
CREATE INDEX "PlatformUser_cloudWorkspaceId_idx" ON "PlatformUser"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_cloudWorkspaceId_username_key" ON "PlatformUser"("cloudWorkspaceId", "username");

-- CreateIndex
CREATE INDEX "OperationConfirmation_cloudWorkspaceId_idx" ON "OperationConfirmation"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "IdempotentOperation_cloudWorkspaceId_idx" ON "IdempotentOperation"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotentOperation_cloudWorkspaceId_actorUserId_toolName_i_key" ON "IdempotentOperation"("cloudWorkspaceId", "actorUserId", "toolName", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OperationAuditEvent_cloudWorkspaceId_idx" ON "OperationAuditEvent"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "CloudImageSnapshot_cloudWorkspaceId_idx" ON "CloudImageSnapshot"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudImageSnapshot_cloudWorkspaceId_provider_accountScopeKe_key" ON "CloudImageSnapshot"("cloudWorkspaceId", "provider", "accountScopeKey", "regionId", "scope", "imageId");

-- CreateIndex
CREATE INDEX "ImageImportJob_cloudWorkspaceId_idx" ON "ImageImportJob"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageImportJob_cloudWorkspaceId_imageId_key" ON "ImageImportJob"("cloudWorkspaceId", "imageId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageImportJob_cloudWorkspaceId_objectKey_key" ON "ImageImportJob"("cloudWorkspaceId", "objectKey");

-- CreateIndex
CREATE INDEX "PackedImageArtifact_cloudWorkspaceId_idx" ON "PackedImageArtifact"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PackedImageArtifact_cloudWorkspaceId_imageId_key" ON "PackedImageArtifact"("cloudWorkspaceId", "imageId");

-- CreateIndex
CREATE INDEX "ImageCatalogItem_cloudWorkspaceId_idx" ON "ImageCatalogItem"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageCatalogItem_cloudWorkspaceId_provider_accountScopeKey__key" ON "ImageCatalogItem"("cloudWorkspaceId", "provider", "accountScopeKey", "regionId", "scope", "imageId");

-- CreateIndex
CREATE INDEX "PlatformImageAsset_cloudWorkspaceId_idx" ON "PlatformImageAsset"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformImageAsset_cloudWorkspaceId_provider_accountScopeKe_key" ON "PlatformImageAsset"("cloudWorkspaceId", "provider", "accountScopeKey", "regionId", "imageId");

-- CreateIndex
CREATE INDEX "PlatformImageTag_cloudWorkspaceId_idx" ON "PlatformImageTag"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformImageTag_cloudWorkspaceId_normalizedName_key" ON "PlatformImageTag"("cloudWorkspaceId", "normalizedName");

-- CreateIndex
CREATE INDEX "PlatformImageAssetTag_cloudWorkspaceId_idx" ON "PlatformImageAssetTag"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "RangeTemplate_cloudWorkspaceId_idx" ON "RangeTemplate"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RangeTemplate_cloudWorkspaceId_slug_version_key" ON "RangeTemplate"("cloudWorkspaceId", "slug", "version");

-- CreateIndex
CREATE INDEX "RangeTemplateVersion_cloudWorkspaceId_idx" ON "RangeTemplateVersion"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "SingleInstanceBatch_cloudWorkspaceId_idx" ON "SingleInstanceBatch"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "RangeInstance_cloudWorkspaceId_idx" ON "RangeInstance"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "SingleInstanceNetworkProfile_cloudWorkspaceId_idx" ON "SingleInstanceNetworkProfile"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SingleInstanceNetworkProfile_cloudWorkspaceId_provider_clou_key" ON "SingleInstanceNetworkProfile"("cloudWorkspaceId", "provider", "cloudAccountUid", "regionId", "zoneId");

-- CreateIndex
CREATE INDEX "ProvisionJob_cloudWorkspaceId_idx" ON "ProvisionJob"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "ProvisionJobStepLog_cloudWorkspaceId_idx" ON "ProvisionJobStepLog"("cloudWorkspaceId");

-- CreateIndex
CREATE INDEX "CloudResourceDrift_cloudWorkspaceId_idx" ON "CloudResourceDrift"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudResourceDrift_cloudWorkspaceId_cloudProvider_regionId__key" ON "CloudResourceDrift"("cloudWorkspaceId", "cloudProvider", "regionId", "cloudResourceType", "cloudResourceId");

-- CreateIndex
CREATE INDEX "BillingLedgerResource_cloudWorkspaceId_idx" ON "BillingLedgerResource"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingLedgerResource_cloudWorkspaceId_cloudProvider_region_key" ON "BillingLedgerResource"("cloudWorkspaceId", "cloudProvider", "regionId", "cloudResourceId", "cloudResourceType");

-- CreateIndex
CREATE INDEX "BillingLineItem_cloudWorkspaceId_idx" ON "BillingLineItem"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingLineItem_cloudWorkspaceId_sourceFingerprint_key" ON "BillingLineItem"("cloudWorkspaceId", "sourceFingerprint");

-- CreateIndex
CREATE INDEX "BillingAnomaly_cloudWorkspaceId_idx" ON "BillingAnomaly"("cloudWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAnomaly_cloudWorkspaceId_sourceFingerprint_key" ON "BillingAnomaly"("cloudWorkspaceId", "sourceFingerprint");

-- AddForeignKey
ALTER TABLE "CloudAccountContext" ADD CONSTRAINT "CloudAccountContext_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformUser" ADD CONSTRAINT "PlatformUser_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationConfirmation" ADD CONSTRAINT "OperationConfirmation_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotentOperation" ADD CONSTRAINT "IdempotentOperation_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationAuditEvent" ADD CONSTRAINT "OperationAuditEvent_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudImageSnapshot" ADD CONSTRAINT "CloudImageSnapshot_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageImportJob" ADD CONSTRAINT "ImageImportJob_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackedImageArtifact" ADD CONSTRAINT "PackedImageArtifact_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageCatalogItem" ADD CONSTRAINT "ImageCatalogItem_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformImageAsset" ADD CONSTRAINT "PlatformImageAsset_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformImageTag" ADD CONSTRAINT "PlatformImageTag_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformImageAssetTag" ADD CONSTRAINT "PlatformImageAssetTag_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeTemplate" ADD CONSTRAINT "RangeTemplate_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeTemplateVersion" ADD CONSTRAINT "RangeTemplateVersion_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SingleInstanceBatch" ADD CONSTRAINT "SingleInstanceBatch_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeInstance" ADD CONSTRAINT "RangeInstance_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SingleInstanceNetworkProfile" ADD CONSTRAINT "SingleInstanceNetworkProfile_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionJob" ADD CONSTRAINT "ProvisionJob_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionJobStepLog" ADD CONSTRAINT "ProvisionJobStepLog_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudResourceDrift" ADD CONSTRAINT "CloudResourceDrift_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedgerResource" ADD CONSTRAINT "BillingLedgerResource_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLineItem" ADD CONSTRAINT "BillingLineItem_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAnomaly" ADD CONSTRAINT "BillingAnomaly_cloudWorkspaceId_fkey" FOREIGN KEY ("cloudWorkspaceId") REFERENCES "CloudWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Prevent nested writes from attaching resources in a different workspace.
-- Existing audit owner/source references remain unchanged, including legacy historical IDs.
CREATE FUNCTION "enforce_cloud_workspace_links"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb := to_jsonb(NEW); old_data jsonb; field_name text; target_table text; target_space text;
BEGIN
 IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD);
  IF row_data->>'cloudWorkspaceId' IS DISTINCT FROM old_data->>'cloudWorkspaceId' THEN
   RAISE EXCEPTION 'Cloud workspace is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 FOR i IN 0..(TG_NARGS/2-1) LOOP
  field_name := TG_ARGV[i*2]; target_table := TG_ARGV[i*2+1];
  IF row_data->>field_name IS NULL OR TG_OP='UPDATE' AND row_data->>field_name IS NOT DISTINCT FROM old_data->>field_name THEN CONTINUE; END IF;
  EXECUTE format('SELECT "cloudWorkspaceId" FROM %I WHERE "id"=$1',target_table) INTO target_space USING row_data->>field_name;
  IF target_space IS NOT NULL AND target_space IS DISTINCT FROM row_data->>'cloudWorkspaceId' THEN
   RAISE EXCEPTION 'Cross-workspace reference rejected: %',field_name USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER "ImageImportJob_workspace_links" BEFORE INSERT OR UPDATE ON "ImageImportJob" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('cloudAccountContextId','CloudAccountContext','ownerUserId','PlatformUser');
CREATE TRIGGER "PackedImageArtifact_workspace_links" BEFORE INSERT OR UPDATE ON "PackedImageArtifact" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('cloudAccountContextId','CloudAccountContext','ownerUserId','PlatformUser','sourceRangeInstanceId','RangeInstance','sourceSnapshotId','CloudImageSnapshot','platformImageAssetId','PlatformImageAsset');
CREATE TRIGGER "ImageCatalogItem_workspace_links" BEFORE INSERT OR UPDATE ON "ImageCatalogItem" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('sourceSnapshotId','CloudImageSnapshot');
CREATE TRIGGER "PlatformImageAsset_workspace_links" BEFORE INSERT OR UPDATE ON "PlatformImageAsset" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('sourceSnapshotId','CloudImageSnapshot','ownerUserId','PlatformUser');
CREATE TRIGGER "PlatformImageTag_workspace_links" BEFORE INSERT OR UPDATE ON "PlatformImageTag" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('createdByUserId','PlatformUser');
CREATE TRIGGER "PlatformImageAssetTag_workspace_links" BEFORE INSERT OR UPDATE ON "PlatformImageAssetTag" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('platformImageAssetId','PlatformImageAsset','tagId','PlatformImageTag');
CREATE TRIGGER "RangeTemplate_workspace_links" BEFORE INSERT OR UPDATE ON "RangeTemplate" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('ownerUserId','PlatformUser','currentDraftVersionId','RangeTemplateVersion','currentPublishedVersionId','RangeTemplateVersion');
CREATE TRIGGER "RangeTemplateVersion_workspace_links" BEFORE INSERT OR UPDATE ON "RangeTemplateVersion" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('templateId','RangeTemplate');
CREATE TRIGGER "SingleInstanceBatch_workspace_links" BEFORE INSERT OR UPDATE ON "SingleInstanceBatch" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('ownerUserId','PlatformUser','platformImageAssetId','PlatformImageAsset');
CREATE TRIGGER "RangeInstance_workspace_links" BEFORE INSERT OR UPDATE ON "RangeInstance" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('ownerUserId','PlatformUser','templateId','RangeTemplate','singleInstanceBatchId','SingleInstanceBatch','lastJobId','ProvisionJob','sourceTemplateVersionId','RangeTemplateVersion');
CREATE TRIGGER "ProvisionJob_workspace_links" BEFORE INSERT OR UPDATE ON "ProvisionJob" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('rangeInstanceId','RangeInstance');
CREATE TRIGGER "ProvisionJobStepLog_workspace_links" BEFORE INSERT OR UPDATE ON "ProvisionJobStepLog" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('jobId','ProvisionJob');
CREATE TRIGGER "BillingLedgerResource_workspace_links" BEFORE INSERT OR UPDATE ON "BillingLedgerResource" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('ownerUserId','PlatformUser','rangeInstanceId','RangeInstance','singleInstanceBatchId','SingleInstanceBatch','platformImageAssetId','PlatformImageAsset','sourceProvisionJobId','ProvisionJob');
CREATE TRIGGER "BillingLineItem_workspace_links" BEFORE INSERT OR UPDATE ON "BillingLineItem" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('ownerUserId','PlatformUser','matchedLedgerId','BillingLedgerResource');
CREATE TRIGGER "CloudResourceDrift_workspace_links" BEFORE INSERT OR UPDATE ON "CloudResourceDrift" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('rangeInstanceId','RangeInstance');
CREATE TRIGGER "SingleInstanceNetworkProfile_workspace_links" BEFORE INSERT OR UPDATE ON "SingleInstanceNetworkProfile" FOR EACH ROW EXECUTE FUNCTION "enforce_cloud_workspace_links"('cloudAccountContextId','CloudAccountContext','createdByUserId','PlatformUser');

COMMIT;
