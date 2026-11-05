import type { BillingSourceJob, ProvisionJobStepLogRecord, BillingSourceInstance } from './admin.repository';

// Recovery writes this only after verifying the original immutable image constraint and checking host/disk absence twice.
export function readSingleInstanceCreationRejection(instance: BillingSourceInstance | null | undefined, job: BillingSourceJob,
  step: ProvisionJobStepLogRecord, jobs: BillingSourceJob[]) {
  const config = instance?.singleInstanceConfig;
  if (!instance || instance.instanceMode !== 'single' || instance.cloudProvider !== 'alibaba_cloud' || !instance.singleInstanceBatchId
    || config?.executionBackend !== 'opentofu' || !instance.cloudWorkspaceId || !config.cloudAccountContextId || !config.cloudAccountUid
    || !/^\d{1,32}$/.test(config.cloudAccountUid) || !config.regionId || !config.zoneId?.startsWith(config.regionId + '-')
    || job.rangeInstanceId !== instance.id || job.cloudWorkspaceId !== instance.cloudWorkspaceId
    || step.jobId !== job.id || step.cloudWorkspaceId !== job.cloudWorkspaceId || step.stepName !== 'single_instance_create_rejection'
    || step.status !== 'succeeded' || !step.message || step.message.length > 16_384
    || !job.startedAt || !job.finishedAt || !step.startedAt || !step.finishedAt
    || step.startedAt < job.startedAt || step.finishedAt > job.finishedAt) return null;
  try {
    const value = JSON.parse(step.message), context = value?.executionContext;
    const source = jobs.find(row => row.id === value?.sourceProvisionJobId && row.rangeInstanceId === instance.id && row.cloudWorkspaceId === job.cloudWorkspaceId);
    if (value?.version !== 1 || value.rangeInstanceId !== instance.id || value.reason !== 'InvalidSystemDiskSize.LessThanImageSize'
      || !source || source.status !== 'failed' || source.retryCount !== 0 || !source.startedAt || !source.finishedAt
      || !(source.jobType === 'create' || source.jobType === 'retry' && source.topologySnapshot?.operation === 'create')
      || !(job.id === source.id && job.status === 'failed' || job.status === 'succeeded'
        && (job.jobType === 'destroy' || job.jobType === 'retry' && job.topologySnapshot?.operation === 'destroy'))
      || step.startedAt < source.startedAt || context?.provider !== instance.cloudProvider
      || context.cloudAccountContextId !== config.cloudAccountContextId || context.cloudAccountUid !== config.cloudAccountUid
      || context.regionId !== config.regionId || context.zoneId !== config.zoneId
      || value.imageId !== config.imageId || !/^m-[A-Za-z0-9-]{1,125}$/.test(value.imageId)
      || value.requestedSystemDiskSize !== config.systemDiskSize
      || !Number.isSafeInteger(value.requestedSystemDiskSize) || value.requestedSystemDiskSize < 1
      || !Number.isSafeInteger(value.minimumSystemDiskSize) || value.minimumSystemDiskSize > 65_536
      || value.minimumSystemDiskSize <= value.requestedSystemDiskSize
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.requestId)) return null;
    return { coverage: 'platform_verified_immutable_image_constraint' as const, sourceProvisionJobId: source.id,
      recoveryProvisionJobId: job.id, verifiedAt: step.finishedAt.toISOString(), cloudAccountUid: config.cloudAccountUid, regionId: config.regionId,
      imageId: value.imageId as string, requestedSystemDiskSizeGiB: value.requestedSystemDiskSize as number,
      minimumSystemDiskSizeGiB: value.minimumSystemDiskSize as number, imageQueryRequestId: value.requestId as string, reasonCode: value.reason as string };
  } catch { return null; }
}
