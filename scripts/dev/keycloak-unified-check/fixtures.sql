INSERT INTO "CloudWorkspace" ("id","provider","accountUid","displayName","updatedAt")
VALUES ('fixture-alpha','alibaba_cloud','111000','Fixture alpha',now()),
       ('fixture-beta','alibaba_cloud','222000','Fixture beta',now())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "PlatformUser" ("id","loginUsername","username","cloudWorkspaceId","isPlatformManager","passwordHash","oidcIssuer","oidcSubject","role","updatedAt")
VALUES ('fixture-legacy-owner','fixture-owner','fixture-owner','fixture-alpha',false,'fixture-old-hash','http://127.0.0.1:13463/realms/cyber-range','bc0e793f-4d21-4c8c-8d49-16d664b2ec64','user',now()),
       ('fixture-established-super','fixture-super','fixture-super',NULL,true,'fixture-old-hash','http://127.0.0.1:13463/realms/cyber-range','bc0e793f-4d21-4c8c-8d49-16d664b2ec65','admin',now())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "RangeTemplate" ("id","cloudWorkspaceId","ownerUserId","name","slug","version","modulePathOrRef","variableSchema","outputSchema","visibility","updatedAt")
VALUES ('fixture-template-alpha','fixture-alpha','fixture-legacy-owner','Alpha public fixture','fixture-alpha','1','fixture-only','{}','{}','platform',now()),
       ('fixture-template-beta','fixture-beta',NULL,'Beta public fixture','fixture-beta','1','fixture-only','{}','{}','platform',now()),
       ('fixture-template-private','fixture-alpha','fixture-legacy-owner','Alpha private fixture','fixture-private','1','fixture-only','{}','{}','private',now())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "RangeTemplateVersion" ("id","cloudWorkspaceId","templateId","version","status","modulePathOrRef","variableSchema","outputSchema","updatedAt")
VALUES ('fixture-version-alpha','fixture-alpha','fixture-template-alpha','1','published','fixture-only','{}','{}',now()),
       ('fixture-version-beta','fixture-beta','fixture-template-beta','1','published','fixture-only','{}','{}',now())
ON CONFLICT ("id") DO NOTHING;
UPDATE "RangeTemplate" SET "currentPublishedVersionId"='fixture-version-alpha' WHERE "id"='fixture-template-alpha';
UPDATE "RangeTemplate" SET "currentPublishedVersionId"='fixture-version-beta' WHERE "id"='fixture-template-beta';
