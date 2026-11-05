import { randomUUID } from 'node:crypto';
import type { BillingLedgerResourceRecord } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';

const resourceTypes: Record<string, string> = { ecs: 'ACS::ECS::Instance', disk: 'ACS::ECS::Disk', eip: 'ACS::EIP::EipAddress', nat_gateway: 'ACS::NAT::NatGateway' };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: unknown) => typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : NaN;

// Config capture timestamps are upper bounds on observed changes, not native deletion timestamps.
export async function readAliyunResourceConfigTimelines(context: SystemCloudAccountContext, ledgers: BillingLedgerResourceRecord[],
  dependencies: { fetch?: typeof fetch; pause?: () => Promise<void>; now?: () => Date } = {}) {
  const now = (dependencies.now ?? (() => new Date()))();
  const selected = [...new Map(ledgers.filter(row => resourceTypes[row.cloudResourceType]).map(row => [row.cloudResourceId, row])).values()]
    .sort((a, b) => Number(b.cloudResourceType === 'ecs') - Number(a.cloudResourceType === 'ecs'));
  const resources: Array<{ cloudResourceId: string; resourceType: string; startAt: string; endAt: string; complete: boolean; errorCode: string | null;
    requestIds: string[]; records: Array<{ resourceEventType: string; captureTime: string; resourceCreateTime: string | null }> }> = [];
  if (!selected.length || selected.length > 20) return { coverage: 'cloud_config_capture_times', complete: false, resources,
    unqueriedResourceIds: selected.map(row => row.cloudResourceId), reasonCode: 'SELECT_1_TO_20_RESOURCES' };
  const secrets = [context.accessKeyId, context.accessKeySecret].filter(Boolean);
  const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value) && !secrets.some(secret => value.includes(secret)) ? value : null;
  for (const ledger of selected) {
    const start = ledger.billingStartAt.getTime() - 300_000, end = Math.min(now.getTime(), (ledger.releasedAt?.getTime() ?? now.getTime()) + 300_000);
    const result: (typeof resources)[number] = { cloudResourceId: ledger.cloudResourceId, resourceType: resourceTypes[ledger.cloudResourceType],
      startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), complete: false, errorCode: null, requestIds: [], records: [] };
    resources.push(result);
    if (context.provider !== 'alibaba_cloud' || !context.accountUid || !ledger.cloudAccountUid || !context.accountUidResolved || context.accountUid !== ledger.cloudAccountUid
      || context.cloudAccountContextId !== ledger.tagsSnapshot.CloudAccountContextId || context.defaultRegion !== ledger.regionId
      || !/^(i|d|eip|ngw)-[a-z0-9]+$/.test(ledger.cloudResourceId) || start >= end || now.getTime() - start > 90 * 86400000) {
      result.errorCode = 'CONFIG_TIMELINE_SCOPE_UNVERIFIED'; continue;
    }
    let token = '', total: number | null = null;
    const tokens = new Set<string>(), records = new Set<string>();
    try {
      for (let page = 0; page < 100; page++) {
        await (dependencies.pause ?? (() => new Promise(resolve => setTimeout(resolve, 220))))();
        const query = signAliyunRpcQuery({ Action: 'GetResourceConfigurationTimeline', Version: '2020-09-07', Format: 'JSON', RegionId: 'cn-shanghai',
          AccessKeyId: context.accessKeyId, SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
          Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), ResourceId: ledger.cloudResourceId, ResourceType: result.resourceType,
          Region: ledger.regionId, StartTime: String(start), EndTime: String(end), MaxResults: '100', ...(token ? { NextToken: token } : {}) }, context.accessKeySecret);
        const response = await (dependencies.fetch ?? fetch)(`https://config.cn-shanghai.aliyuncs.com/?${query}`, { signal: AbortSignal.timeout(30000) });
        const body: unknown = await response.json();
        if (object(body)) { const id = safeId(body.RequestId); if (id) result.requestIds.push(id); }
        if (!response.ok || !object(body) || body.Code != null && body.Code !== 'Success') {
          result.errorCode = object(body) ? sanitizeAliyunErrorCode(body.Code, secrets) ?? 'CONFIG_TIMELINE_UNAVAILABLE' : 'CONFIG_TIMELINE_UNAVAILABLE'; break;
        }
        const timeline = body.ResourceConfigurationTimeline;
        if (!safeId(body.RequestId) || !object(timeline) || !Array.isArray(timeline.ConfigurationList) || timeline.ConfigurationList.length > 100
          || timeline.MaxResults != null && timeline.MaxResults !== 100
          || timeline.TotalCount != null && (!Number.isSafeInteger(timeline.TotalCount) || Number(timeline.TotalCount) < 0 || Number(timeline.TotalCount) > 10_000
            || total !== null && total !== timeline.TotalCount)
          || timeline.NextToken != null && typeof timeline.NextToken !== 'string') throw new Error('Incomplete config page');
        if (timeline.TotalCount != null) total = Number(timeline.TotalCount);
        for (const row of timeline.ConfigurationList) {
          if (!object(row) || String(row.AccountId) !== ledger.cloudAccountUid || row.Region !== ledger.regionId
            || row.ResourceId !== ledger.cloudResourceId || row.ResourceType !== result.resourceType
            || !['DISCOVERED', 'DISCOVERED_REVISED', 'MODIFY', 'MODIFY_REVISED', 'REMOVE'].includes(String(row.ResourceEventType))
            || !Number.isFinite(stamp(row.CaptureTime)) || stamp(row.CaptureTime) < start || stamp(row.CaptureTime) > end) throw new Error('Unverified config identity');
          const key = String(row.CaptureTime) + ':' + row.ResourceEventType;
          if (records.has(key)) throw new Error('Repeated config record'); records.add(key);
          result.records.push({ resourceEventType: String(row.ResourceEventType), captureTime: new Date(stamp(row.CaptureTime)).toISOString(),
            resourceCreateTime: Number.isFinite(stamp(row.ResourceCreateTime)) ? new Date(stamp(row.ResourceCreateTime)).toISOString() : null });
        }
        token = typeof timeline.NextToken === 'string' ? timeline.NextToken : '';
        if (!token) { if (total !== null && result.records.length !== total) throw new Error('Incomplete config history'); result.complete = true; break; }
        if (!timeline.ConfigurationList.length || total !== null && result.records.length >= total || tokens.has(token)) throw new Error('Repeated config pagination');
        tokens.add(token);
      }
      if (!result.complete && !result.errorCode) result.errorCode = 'CONFIG_TIMELINE_INCOMPLETE';
    } catch { result.errorCode = 'CONFIG_TIMELINE_INCOMPLETE'; }
    if (/^(NoPermission|Forbidden|AccessDenied|Unauthorized)([._-]|$)/i.test(result.errorCode ?? '') || result.errorCode === 'AccountNotExisted') break;
  }
  return { coverage: 'cloud_config_capture_times', complete: resources.length === selected.length && resources.every(row => row.complete), resources,
    unqueriedResourceIds: selected.slice(resources.length).map(row => row.cloudResourceId) };
}
