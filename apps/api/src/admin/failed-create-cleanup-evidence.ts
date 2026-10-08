export const FAILED_CREATE_CLEANUP_PROOF_STEP = 'confirm_failed_create_cleanup';
export const FAILED_CREATE_SWITCH_PROOF_STEP = 'verify_failed_create_for_cloud_switch';

export type FailedCreateCleanupProof = {
  version: 1;
  rangeInstanceId: string;
  provisionJobId: string;
  claimStartedAt: string;
  cloudAccountContextId: string;
  cloudAccountUid: string;
  regionId: string;
};

export function readFailedCreateCleanupProof(message: string | null): FailedCreateCleanupProof | null {
  try {
    const value = JSON.parse(message ?? '') as Partial<FailedCreateCleanupProof>;
    return value.version === 1
      && [value.rangeInstanceId, value.provisionJobId, value.claimStartedAt, value.cloudAccountContextId, value.cloudAccountUid, value.regionId]
        .every((field) => typeof field === 'string' && field.trim().length > 0)
      ? value as FailedCreateCleanupProof
      : null;
  } catch {
    return null;
  }
}
