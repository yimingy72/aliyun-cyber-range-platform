import type { CloudProvider, HostCloudReleaseDeadline } from '../admin/admin.repository';
import { cloudItems, cloudTotal, imageRpc } from '../admin/aliyun-image-rpc';
import { requestTencentCloud } from '../admin/tencent-cloud-client';
import type { ResolvedProvisioningRuntimeConfig } from './provisioning.types';

const MINUTE = 60_000;
const REQUEST_MARGIN_MS = 2 * MINUTE;
// Conservative three-year bound, including leap years and minute rounding.
export const ALIBABA_MAX_RELEASE_DELAY_MS = 1095 * 24 * 60 * MINUTE;

function utcTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Cloud release deadline requires an explicit timezone');
  return time;
}
const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function assertPlatformExpirationSupportsCloudDeadline(provider: CloudProvider, platformExpiresAt: string, now = new Date()) {
  const expiresAt = utcTime(platformExpiresAt);
  if (expiresAt <= now.getTime()) throw new Error('Platform expiry reached before host creation');
  const latestRelease = Math.ceil((expiresAt + 5 * MINUTE) / MINUTE) * MINUTE;
  if (provider === 'alibaba_cloud' && latestRelease - now.getTime() > ALIBABA_MAX_RELEASE_DELAY_MS) {
    throw new Error('阿里云到期时间必须为云端兜底预留 5 分钟及分钟取整余量，云端截止时间不能超过 1095 天。');
  }
}

/** Freeze this record before the first host apply; retries reuse it without recalculation. */
export function createHostCloudReleaseDeadline(input: { provider: CloudProvider; platformExpiresAt: string; creationPhaseStartedAt: string; sourceProvisionJobId: string }): HostCloudReleaseDeadline {
  const expiresAt = utcTime(input.platformExpiresAt), startedAt = utcTime(input.creationPhaseStartedAt);
  if (startedAt >= expiresAt) throw new Error('Platform expiry reached before host creation');
  assertPlatformExpirationSupportsCloudDeadline(input.provider, input.platformExpiresAt, new Date(startedAt));
  if (!input.sourceProvisionJobId) throw new Error('Cloud release deadline requires its original creation job');
  const deadline = input.provider === 'alibaba_cloud'
    ? Math.ceil(Math.max(expiresAt + 5 * MINUTE, startedAt + 30 * MINUTE + REQUEST_MARGIN_MS) / MINUTE) * MINUTE
    : expiresAt + 5 * MINUTE;
  return { provider: input.provider, platformExpiresAt: new Date(expiresAt).toISOString(), creationPhaseStartedAt: new Date(startedAt).toISOString(),
    cloudReleaseAt: iso(deadline), sourceProvisionJobId: input.sourceProvisionJobId, status: 'unverified' };
}

export function assertCloudReleaseDeadlineCanCreate(record: HostCloudReleaseDeadline, now = new Date()) {
  if (now.getTime() >= utcTime(record.platformExpiresAt)) throw new Error('Platform expiry reached before host creation');
  const remaining = utcTime(record.cloudReleaseAt) - now.getTime();
  if (record.provider === 'alibaba_cloud' && remaining > ALIBABA_MAX_RELEASE_DELAY_MS) throw new Error('Frozen Alibaba cloud release deadline exceeds the 1095-day provider limit');
  if (remaining < (record.provider === 'alibaba_cloud' ? 30 * MINUTE + 15_000 : 5 * MINUTE + 15_000))
    throw new Error('Frozen cloud release deadline is too close; it cannot be extended by retry');
}

/** Read native configuration only. A failed read never destroys or recreates a host. */
export async function verifyCloudReleaseDeadlines(input: { account: ResolvedProvisioningRuntimeConfig; hostIds: Record<string, string>; deadlines: Record<string, HostCloudReleaseDeadline>; now?: Date }): Promise<Record<string, HostCloudReleaseDeadline>> {
  const now = input.now ?? new Date(), result = structuredClone(input.deadlines);
  const ids = Object.values(input.hostIds);
  const provider = input.account.provider ?? 'alibaba_cloud';
  const validIdentity = new Set(ids).size === ids.length && ids.every(id => (provider === 'alibaba_cloud' ? /^i-[A-Za-z0-9-]+$/ : /^ins-[a-z0-9]+$/).test(id));
  for (const [key, record] of Object.entries(result)) {
    record.lastCheckedAt = now.toISOString();
    record.status = record.cloudReleaseAt ? 'unverified' : 'not_configured';
    delete record.verifiedAt;
    record.reason = 'verification_pending';
    if (!validIdentity || record.provider !== provider || !input.hostIds[key]) { delete record.instanceId; record.reason = 'instance_identity_unavailable'; continue; }
    record.instanceId = input.hostIds[key];
  }
  if (!validIdentity) return result;
  try {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      if (provider === 'alibaba_cloud') {
        const response = await imageRpc({ ...input.account, regionId: input.account.defaultRegion }, 'DescribeInstances', { RegionId: input.account.defaultRegion, InstanceIds: JSON.stringify(batch), PageSize: '100' });
        const instances = cloudItems<{ InstanceId?: string; AutoReleaseTime?: string }>(response, 'Instances', 'Instance');
        if (cloudTotal(response) !== instances.length || instances.some(item => !item.InstanceId || !batch.includes(item.InstanceId)) || new Set(instances.map(item => item.InstanceId)).size !== instances.length)
          throw new Error('Incomplete native deadline inventory');
        for (const [key, record] of Object.entries(result)) if (record.instanceId && batch.includes(record.instanceId)) {
          const item = instances.find(item => item.InstanceId === record.instanceId);
          if (!item) { record.reason = 'instance_not_found'; continue; }
          if (!item.AutoReleaseTime) { record.status = 'not_configured'; record.reason = 'timer_not_configured'; continue; }
          record.reason = 'timer_mismatch';
          if (Date.parse(item.AutoReleaseTime) === utcTime(record.cloudReleaseAt)) {
            record.status = 'verified'; record.verifiedAt = now.toISOString(); delete record.reason;
          }
        }
      } else {
        const response = await requestTencentCloud<{ ActionTimers?: Array<{ InstanceId?: string; TimerAction?: string; ActionTime?: string; Status?: string; ActionTimerId?: string }> }>({
          service: 'cvm', version: '2017-03-12', action: 'DescribeInstancesActionTimer', regionId: input.account.defaultRegion,
          accessKeyId: input.account.accessKeyId, accessKeySecret: input.account.accessKeySecret, parameters: { InstanceIds: batch },
        });
        if (!Array.isArray(response.ActionTimers) || response.ActionTimers.some(timer => !timer.InstanceId || !batch.includes(timer.InstanceId) || typeof timer.ActionTimerId !== 'string'))
          throw new Error('Malformed native timer inventory');
        for (const record of Object.values(result)) if (record.instanceId && batch.includes(record.instanceId)) {
          const timers = response.ActionTimers.filter(timer => timer.InstanceId === record.instanceId && timer.TimerAction === 'TerminateInstances');
          if (!timers.length) { record.status = 'not_configured'; record.reason = 'timer_not_configured'; continue; }
          record.reason = 'timer_mismatch';
          if (timers.length === 1 && timers[0].Status === 'UNDO' && Date.parse(timers[0].ActionTime ?? '') === utcTime(record.cloudReleaseAt)) {
            record.status = 'verified'; record.verifiedAt = now.toISOString(); delete record.reason;
          }
        }
      }
    }
  } catch {
    for (const record of Object.values(result)) if (record.status !== 'verified') { record.status = 'unverified'; record.reason = 'native_timer_check_failed'; }
  }
  return result;
}
