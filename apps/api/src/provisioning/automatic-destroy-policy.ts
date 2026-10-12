// Pure admission policy. No cloud call or billing mutation belongs in expiry intake.
type ExpiringSingleInstance = {
  id: string;
  instanceMode: string;
  status: string;
  expiresAt: Date | null;
  lastJobId: string | null;
  cloudWorkspaceId?: string;
  singleInstanceConfig?: unknown;
};
type PreviousJob = {
  id: string;
  rangeInstanceId: string;
  cloudWorkspaceId?: string;
  jobType: string;
  status: string;
  triggeredBy: string;
  retryCount: number;
  finishedAt: Date | null;
  errorSummary: string | null;
};

export function expiredSingleDestroyDecision(instance: ExpiringSingleInstance, previous: PreviousJob | null, now: Date) {
  if (!Number.isFinite(now.getTime()) || instance.instanceMode !== 'single'
    || !instance.expiresAt || !Number.isFinite(instance.expiresAt.getTime()) || instance.expiresAt > now
    || !['running', 'creating', 'destroy_failed'].includes(instance.status)) return null;
  if (instance.lastJobId !== (previous?.id ?? null)
    || previous && (previous.rangeInstanceId !== instance.id
      || (previous.cloudWorkspaceId ?? 'legacy-unbound') !== (instance.cloudWorkspaceId ?? 'legacy-unbound'))) return null;

  if (instance.status === 'destroy_failed') {
    const binding = instance.singleInstanceConfig;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || !['cloudAccountContextId', 'cloudAccountUid', 'regionId'].every(key => {
        const value = (binding as Record<string, unknown>)[key];
        return typeof value === 'string' && value.trim().length > 0;
      })) return null;
    const error = previous?.errorSummary ?? '';
    const transient = /timeout|timed out|temporar|throttl|RequestLimit|InternalError|ECONN|ETIMEDOUT|status 50[0-9]|NETWORK_OR_TIMEOUT/i.test(error)
      && !/unverified|ownership|identity|binding|recovery|required state|unknown|unauthor|forbidden|credential/i.test(error);
    if (!previous || previous.status !== 'failed' || previous.jobType !== 'destroy'
      || previous.triggeredBy !== 'system:auto-expire' || !transient
      || !Number.isSafeInteger(previous.retryCount) || previous.retryCount < 0 || previous.retryCount >= 3
      || !previous.finishedAt || !Number.isFinite(previous.finishedAt.getTime())
      || now.getTime() < previous.finishedAt.getTime() + 60_000 * 2 ** previous.retryCount) return null;
    return { retryCount: previous.retryCount + 1, supersedeJobId: null as string | null };
  }

  // Never replace an executing cloud operation, or an already accepted destroy.
  if (previous?.status === 'running' && previous.jobType !== 'refresh_status'
    || previous?.jobType === 'destroy' && ['pending', 'running'].includes(previous.status)) return null;
  return { retryCount: 0, supersedeJobId: previous && ['pending', 'running'].includes(previous.status) ? previous.id : null };
}
