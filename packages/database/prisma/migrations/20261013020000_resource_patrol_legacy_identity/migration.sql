-- Workspace identity locates old candidates; it does not establish resource creation or deletion proof.
UPDATE "CloudResourceDrift" AS drift
SET "accountUid" = workspace."accountUid"
FROM "CloudWorkspace" AS workspace
WHERE drift."accountUid" IS NULL
  AND drift."cloudWorkspaceId" = workspace."id"
  AND drift."cloudProvider" = workspace."provider"
  AND workspace."accountUid" IS NOT NULL
  AND btrim(workspace."accountUid") <> '';
