ALTER TABLE "ProvisionJob"
ADD COLUMN "topologySnapshot" JSONB;

UPDATE "ProvisionJob" AS job
SET "topologySnapshot" = jsonb_build_object(
  'draftRevision', instance."draftRevision",
  'topologyGraph', instance."draftTopologyGraph",
  'topologySpec', instance."draftTopologySpec",
  'scenarioTemplateSpec', instance."draftScenarioTemplateSpec",
  'compiledProvisionSpec', instance."draftCompiledProvisionSpec",
  'compiledSpec', COALESCE(template_version."compiledSpec", template."compiledSpec"),
  'templateModulePath', COALESCE(
    template_version."modulePathOrRef",
    instance."templateModulePathSnapshot",
    template."modulePathOrRef"
  )
)
FROM "RangeInstance" AS instance
LEFT JOIN "RangeTemplateVersion" AS template_version
  ON template_version."id" = instance."sourceTemplateVersionId"
LEFT JOIN "RangeTemplate" AS template
  ON template."id" = instance."templateId"
WHERE job."rangeInstanceId" = instance."id"
  AND job."jobType" = 'update'
  AND job."status" IN ('pending', 'running')
  AND job."topologySnapshot" IS NULL
  AND instance."draftRevision" > 0
  AND instance."draftUpdatedAt" <= job."createdAt"
  AND instance."draftTopologyGraph" IS NOT NULL
  AND instance."draftTopologySpec" IS NOT NULL
  AND instance."draftScenarioTemplateSpec" IS NOT NULL
  AND instance."draftCompiledProvisionSpec" IS NOT NULL
  AND COALESCE(template_version."compiledSpec", template."compiledSpec") IS NOT NULL
  AND COALESCE(
    template_version."modulePathOrRef",
    instance."templateModulePathSnapshot",
    template."modulePathOrRef"
  ) IS NOT NULL;

UPDATE "ProvisionJob"
SET
  "status" = 'failed',
  "finishedAt" = NOW(),
  "errorSummary" = 'Update job predates immutable topology snapshots. Re-save the topology draft and apply changes again.'
WHERE "jobType" = 'update'
  AND "status" IN ('pending', 'running')
  AND "topologySnapshot" IS NULL;
