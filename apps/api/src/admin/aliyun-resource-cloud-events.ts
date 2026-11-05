import { randomUUID } from 'node:crypto';
import type { BillingLedgerResourceRecord } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const identity = (value: unknown) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(text(value));
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const keys = ['InstanceId', 'InstanceIds', 'InstanceType', 'AllocationId', 'DiskId', 'NatGatewayId', 'InternetChargeType',
  'Bandwidth', 'ISP', 'Isp', 'PublicIpAddressPoolId', 'CommonBandwidthPackageId', 'ChargeType', 'AutoReleaseTime', 'ReleaseTime'];

export type AliyunResourceCloudEvents = {
  cloudResourceId: string; cloudResourceType: string; startAt: string; endAt: string;
  complete: boolean; requestIds: string[]; errorCode: string | null;
  events: Array<{ eventId: string; eventTime: string; eventName: string; eventType: string;
    serviceName: string; requestId: string | null; errorCode: string | null; parameters: Record<string, string | number | boolean> }>;
};

// ResourceName restricts discovery. It does not prove deletion; callers must inspect native
// successful events and independently verify absence before changing a billing lifetime.
export async function readAliyunResourceCloudEvents(context: SystemCloudAccountContext, ledger: BillingLedgerResourceRecord,
  dependencies: { fetch?: typeof fetch; pause?: () => Promise<void>; now?: () => Date } = {}): Promise<AliyunResourceCloudEvents> {
  const now = (dependencies.now ?? (() => new Date()))();
  const start = new Date(Math.floor(ledger.billingStartAt.getTime() / 1000) * 1000 - 300_000);
  const end = new Date(Math.min(now.getTime() - 900_000, (ledger.releasedAt?.getTime() ?? now.getTime()) + 300_000));
  const result: AliyunResourceCloudEvents = { cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType,
    startAt: iso(start), endAt: iso(end), complete: false, requestIds: [], events: [], errorCode: null };
  if (context.provider !== 'alibaba_cloud' || !context.accountUidResolved || context.accountUid !== ledger.cloudAccountUid
    || context.defaultRegion !== ledger.regionId || context.cloudAccountContextId !== ledger.tagsSnapshot.CloudAccountContextId
    || !['ecs', 'disk', 'nat_gateway', 'eip'].includes(ledger.cloudResourceType) || !/^(i|d|ngw|eip)-[a-z0-9]+$/i.test(ledger.cloudResourceId)
    || start >= end || now.getTime() - start.getTime() > 89 * 86400000) return { ...result, errorCode: 'CLOUD_EVENT_SCOPE_UNVERIFIED' };
  const secrets = [context.accessKeyId, context.accessKeySecret].filter(Boolean);
  const safe = (value: unknown) => identity(value) && !secrets.some(secret => text(value).includes(secret)) ? text(value) : null;
  const seenEvents = new Set<string>(), seenTokens = new Set<string>();
  let nextToken = '';
  try {
    for (let page = 0; page < 100; page++) {
      await (dependencies.pause ?? (() => new Promise(resolve => setTimeout(resolve, 600))))();
      const query = signAliyunRpcQuery({ Action: 'LookupEvents', Version: '2020-07-06', AccessKeyId: context.accessKeyId,
        Format: 'JSON', RegionId: ledger.regionId, SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(),
        SignatureVersion: '1.0', Timestamp: iso(now), StartTime: result.startAt, EndTime: result.endAt,
        MaxResults: '50', Direction: 'FORWARD', 'LookupAttribute.1.Key': 'ResourceName', 'LookupAttribute.1.Value': ledger.cloudResourceId,
        ...(nextToken ? { NextToken: nextToken } : {}) }, context.accessKeySecret);
      const response = await (dependencies.fetch ?? fetch)(`https://actiontrail.${ledger.regionId}.aliyuncs.com/?${query}`, { signal: AbortSignal.timeout(30000) });
      const body: unknown = await response.json();
      if (!response.ok || !object(body) || body.Code != null && body.Code !== 'Success') {
        result.errorCode = object(body) ? sanitizeAliyunErrorCode(body.Code, secrets) || 'CLOUD_EVENTS_UNAVAILABLE' : 'CLOUD_EVENTS_UNAVAILABLE';
        return result;
      }
      const requestId = safe(body.RequestId);
      if (!requestId || body.StartTime !== result.startAt || body.EndTime !== result.endAt || !Array.isArray(body.Events)
        || body.Events.length > 50 || body.NextToken != null && typeof body.NextToken !== 'string') throw new Error('Incomplete cloud event page');
      result.requestIds.push(requestId);
      for (const event of body.Events) {
        if (!object(event)) throw new Error('Invalid cloud event');
        const eventId = safe(event.eventId), eventName = safe(event.eventName), serviceName = safe(event.serviceName), eventType = safe(event.eventType);
        const time = Date.parse(text(event.eventTime));
        const owner = event.recipientAccountId ?? (object(event.userIdentity) ? event.userIdentity.accountId : null);
        if (!eventId || !eventName || !serviceName || !eventType || seenEvents.has(eventId) || owner !== ledger.cloudAccountUid
          || event.acsRegion !== ledger.regionId || !Number.isFinite(time) || time < start.getTime() || time > end.getTime()) throw new Error('Unverified cloud event identity');
        seenEvents.add(eventId);
        // Read events add no lifecycle evidence and may expose unrelated request arguments.
        if (event.eventRW === 'Read' || /^(Describe|List|Get|Query|Check|Lookup)/.test(eventName)) continue;
        let parameters = event.requestParameters;
        if (parameters == null && typeof event.requestParameterJson === 'string') parameters = JSON.parse(event.requestParameterJson);
        const projected: Record<string, string | number | boolean> = {};
        if (object(parameters)) for (const key of keys) {
          const value = parameters[key] ?? parameters[key[0].toLowerCase() + key.slice(1)];
          if ((typeof value === 'string' && value.length <= 512 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean')
            && !secrets.some(secret => String(value).includes(secret))) projected[key] = value;
        }
        result.events.push({ eventId, eventTime: new Date(time).toISOString(), eventName, serviceName, eventType,
          requestId: safe(event.requestId), errorCode: event.errorCode ? sanitizeAliyunErrorCode(event.errorCode, secrets) || 'UNKNOWN_CLOUD_ERROR' : null,
          parameters: projected });
      }
      nextToken = text(body.NextToken);
      if (!nextToken) return { ...result, complete: true };
      if (!body.Events.length || seenTokens.has(nextToken)) throw new Error('Incomplete cloud event pagination');
      seenTokens.add(nextToken);
    }
  } catch { result.errorCode = 'CLOUD_EVENTS_INCOMPLETE'; }
  return { ...result, errorCode: result.errorCode ?? 'CLOUD_EVENTS_INCOMPLETE' };
}
