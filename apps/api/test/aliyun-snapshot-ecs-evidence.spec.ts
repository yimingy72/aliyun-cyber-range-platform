import {
  ALIYUN_PACK_SNAPSHOT_BASELINE_KIND, aliyunSnapshotHistoryStartAt, collectAliyunPackSnapshotBaseline, collectAliyunSnapshotHistory,
  readAliyunPackSnapshotBaseline, readAliyunSnapshotEcsScope, verifyAliyunSnapshotEcsBillEvidence,
  type AliyunSnapshotEvent, type AliyunSnapshotHistory,
} from '../src/admin/aliyun-snapshot-ecs-evidence';
import type { BillingLedgerResourceRecord, PackedImageArtifactRecord, ProvisionJobRecord } from '../src/admin/admin.repository';
import type { PlatformBillingProof } from '../src/admin/billing-platform-scope';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const credentials = { provider: 'alibaba_cloud', accountUid: '123456', accessKeyId: 'mock-ak', accessKeySecret: 'mock-sk', cloudAccountContextId: 'ctx-owned' };
const now = () => new Date('2026-10-12T02:00:00.000Z');
const source = (): BillingLedgerResourceRecord => ({ id: 'ledger-host', cloudWorkspaceId: 'space-owned', cloudProvider: 'alibaba_cloud', cloudAccountUid: '123456', regionId: 'cn-hangzhou',
  cloudResourceType: 'ecs', cloudResourceId: 'i-owned', billingScope: 'user', ownerUserId: 'user-owned', rangeInstanceId: 'range-owned', singleInstanceBatchId: null,
  sourceProvisionJobId: 'job-create', billingStartAt: new Date('2026-10-09T00:00:00Z'), createdAt: new Date('2026-10-09T00:00:30Z'),
  releasedAt: new Date('2026-10-09T01:30:00Z'), tagsSnapshot: {}, platformImageAssetId: null, updatedAt: new Date('2026-10-09T01:30:00Z') });
function artifact(): PackedImageArtifactRecord {
  const row = { id: 'artifact-owned', cloudProvider: 'alibaba_cloud', cloudWorkspaceId: 'space-owned', cloudAccountContextId: 'ctx-owned', cloudAccountUid: '123456', regionId: 'cn-hangzhou',
    ownerUserId: 'user-owned', sourceRangeInstanceId: 'range-owned', sourceHostKey: 'ecs-owned', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'],
    imageId: 'm-owned', backingSnapshotIds: ['s-owned'], sourceSnapshotId: null, sourceSnapshotBaseline: null, platformImageAssetId: null,
    status: 'deleted', deletedSnapshotIds: ['s-owned'], createdAt: new Date('2026-10-09T01:00:00Z'), updatedAt: new Date('2026-10-10T01:00:00Z'),
    cloudImageDeletedAt: new Date('2026-10-10T01:00:00Z'), completedAt: null, lastPolledAt: null, errorMessage: null } as PackedImageArtifactRecord;
  row.sourceSnapshotBaseline = { ...row, kind: ALIYUN_PACK_SNAPSHOT_BASELINE_KIND, sourceDisks: [{ sourceDiskId: 'd-owned', snapshotIds: [], requestIds: ['snap-baseline-request'] }],
    autoSnapshotPolicyIds: [], policyRequestIds: ['policy-baseline-request'], observedAt: '2026-10-09T00:59:50Z' };
  return row;
}
function proof(): PlatformBillingProof {
  const host = source();
  const disk = { ...host, id: 'ledger-disk', cloudResourceType: 'disk', cloudResourceId: 'd-owned' } as BillingLedgerResourceRecord;
  const snapshot = { ...host, id: 'ledger-snapshot', cloudResourceType: 'snapshot', cloudResourceId: 's-owned', billingStartAt: new Date('2026-10-09T01:00:00Z'), releasedAt: new Date('2026-10-10T01:00:00Z') } as BillingLedgerResourceRecord;
  return { ledgers: [host, disk, snapshot], packedImages: [artifact()], imageImports: [], cosBuckets: [], createdLedgerIds: new Set([host.id, disk.id, snapshot.id]), unverifiedSourceLedgerIds: new Set(),
    creationJobs: new Map([[host.id, { id: 'job-create', createdAt: new Date('2026-10-09T00:00:00Z'), startedAt: new Date('2026-10-09T00:00:00Z') } as ProvisionJobRecord]]) };
}
const event = (input: Partial<AliyunSnapshotEvent>): AliyunSnapshotEvent => ({ id: 'event-owned', time: '2026-10-09T01:00:01Z', name: 'CreateImage', type: 'ApiCall', failed: false,
  requestResourceIds: ['i-owned'], responseResourceIds: ['m-owned'], resourceIds: [], ...input });
const history = (): AliyunSnapshotHistory => ({ version: 1, provider: 'alibaba_cloud', cloudWorkspaceId: 'space-owned', cloudAccountUid: '123456', regionId: 'cn-hangzhou', sourceInstanceId: 'i-owned',
  startAt: '2026-10-08T23:59:59Z', endAt: '2026-10-10T15:59:59Z', observedAt: now().toISOString(), requestIds: ['lookup-request'],
  events: [event({ id: 'event-born', name: 'RunInstances', time: '2026-10-09T00:00:10Z', requestResourceIds: [], responseResourceIds: ['i-owned'] }), event({ id: 'event-image' }),
    event({ id: 'event-delete', name: 'DeleteSnapshot', time: '2026-10-10T01:00:00Z', requestResourceIds: ['s-owned'], responseResourceIds: [] })] });
const line = () => ({ __platformBillingSource: 'DescribeSplitItemBill', __platformCloudProvider: 'alibaba_cloud', ProductCode: 'snapshot', SplitItemID: 'i-owned',
  RegionId: 'cn-hangzhou', OwnerID: '123456', SplitAccountID: '123456', PretaxAmount: '0.000123456789', Item: 'PayAsYouGoBill' });
const verify = (changes: Partial<Parameters<typeof verifyAliyunSnapshotEcsBillEvidence>[0]> = {}) => verifyAliyunSnapshotEcsBillEvidence({ line: line(), billingDate: '2026-10-10', cloudAccountUid: '123456', proof: proof(), history: history(), ...changes });

describe('Alibaba source-ECS snapshot amount evidence', () => {
  it('accepts the native Chinese region name using the source bill region ID', () => {
    const native = { ...line(), RegionId: undefined, Region: '华东1（杭州）', InstanceID: 'cn-hangzhou' };
    expect(verify({ line: native })?.sourceInstanceId).toBe('i-owned');
  });
  it('retains the official source-host total and exact backing snapshot IDs after parent destruction', () => {
    const result = verify();
    expect(result).toMatchObject({ kind: 'snapshot_ecs', sourceLedgerId: 'ledger-host', sourceInstanceId: 'i-owned', snapshotLedgerIds: ['ledger-snapshot'], snapshotIds: ['s-owned'], artifactIds: ['artifact-owned'] });
    expect(result).not.toHaveProperty('amount');
    expect(readAliyunSnapshotEcsScope({ ...line(), __platformSnapshotEcsScope: result }, proof(), '2026-10-10', '123456')).toEqual(result);
  });
  it('does not treat a platform-created ECS as proof of a manual snapshot that was subsequently deleted', () => {
    const value = history();
    value.events.push(event({ id: 'event-manual', name: 'CreateSnapshot', requestResourceIds: ['d-owned'], responseResourceIds: ['s-foreign'] }),
      event({ id: 'event-manual-delete', name: 'DeleteSnapshot', requestResourceIds: ['s-foreign'], responseResourceIds: [] }));
    expect(verify({ history: value })).toBeNull();
  });
  it.each(['CreateSnapshotGroup', 'CopySnapshot', 'ImportSnapshot', 'AttachDisk', 'DetachDisk', 'ReplaceSystemDisk'])('leaves %s source changes pending', name => {
    const value = history(); value.events.push(event({ id: 'event-change', name, requestResourceIds: ['i-owned', 'd-owned', 's-owned'], responseResourceIds: [] }));
    expect(verify({ history: value })).toBeNull();
  });
  it.each(['ApplyAutoSnapshotPolicy', 'CreateAutoSnapshotPolicy', 'ModifyAutoSnapshotPolicyEx', 'DeleteAutoSnapshotPolicy'])('leaves %s pending, including policies removed before current inventory', name => {
    const value = history(); value.events.push(event({ id: 'event-policy', name, requestResourceIds: ['sp-other'], responseResourceIds: [] }));
    expect(verify({ history: value })).toBeNull();
  });
  it('keeps old artifacts with no submission baseline pending instead of synthesizing it today', () => {
    const value = proof(); value.packedImages[0].sourceSnapshotBaseline = null;
    expect(verify({ proof: value })).toBeNull();
  });
  it('does not accept a pre-existing tag auto-snapshot policy or external prior snapshot', () => {
    const value = proof(); value.packedImages[0].sourceSnapshotBaseline!.autoSnapshotPolicyIds = ['sp-foreign'];
    expect(verify({ proof: value })).toBeNull();
    value.packedImages[0].sourceSnapshotBaseline!.autoSnapshotPolicyIds = [];
    (value.packedImages[0].sourceSnapshotBaseline!.sourceDisks as any[])[0].snapshotIds = ['s-deletedforeign'];
    expect(verify({ proof: value })).toBeNull();
  });
  it('rejects retroactive or unsettled baselines and incomplete audit coverage', () => {
    const value = proof(); value.packedImages[0].sourceSnapshotBaseline!.observedAt = '2026-10-10T15:55:00Z';
    expect(verify({ proof: value })).toBeNull();
    const incomplete = history(); incomplete.startAt = '2026-10-09T00:01:00Z';
    expect(verify({ history: incomplete })).toBeNull();
    const unsettled = history(); unsettled.observedAt = '2026-10-10T16:00:00Z';
    expect(verify({ history: unsettled })).toBeNull();
  });
  it('requires the official birth event, all source disks and every exact image/snapshot artifact', () => {
    const value = history(); value.events = value.events.filter(row => row.name !== 'RunInstances');
    expect(verify({ history: value })).toBeNull();
    const records = proof(); records.createdLedgerIds.delete('ledger-disk');
    expect(verify({ proof: records })).toBeNull();
    expect(verify({ history: { ...history(), events: history().events.filter(row => row.name !== 'CreateImage') } })).toBeNull();
  });
  it('does not accept an unknown manual image or a failed creation result', () => {
    const value = history(); value.events.push(event({ id: 'event-foreignimage', responseResourceIds: ['m-foreign'] }));
    expect(verify({ history: value })).toBeNull();
    value.events.pop(); value.events[1].failed = true;
    expect(verify({ history: value })).toBeNull();
  });
  it.each(['cloudWorkspaceId', 'cloudAccountUid', 'regionId', 'sourceInstanceId'])('rejects a history from another %s', key => {
    expect(verify({ history: { ...history(), [key]: 'foreign' } })).toBeNull();
  });
  it('rejects regional account aggregation, mismatched split account, and raw evidence flags without a complete chain', () => {
    expect(verify({ line: { ...line(), SplitItemID: 'cn-hangzhou' } })).toBeNull();
    expect(verify({ line: { ...line(), SplitAccountID: 'foreign' } })).toBeNull();
    expect(readAliyunSnapshotEcsScope({ ...line(), __platformSnapshotEcsScope: { kind: 'snapshot_ecs', version: 1 } }, proof(), '2026-10-10', '123456')).toBeNull();
    const scope = verify()!;
    for (const key of ['sourceLedgerId', 'sourceInstanceId', 'cloudWorkspaceId', 'cloudAccountUid', 'regionId']) {
      expect(readAliyunSnapshotEcsScope({ ...line(), __platformSnapshotEcsScope: { ...scope, [key]: 'foreign' } }, proof(), '2026-10-10', '123456')).toBeNull();
    }
    expect(readAliyunSnapshotEcsScope({ ...line(), __platformSnapshotEcsScope: { ...scope, snapshotIds: ['s-foreign'] } }, proof(), '2026-10-10', '123456')).toBeNull();
    const records = proof(); records.packedImages[0].ownerUserId = 'foreign';
    expect(readAliyunSnapshotEcsScope({ ...line(), __platformSnapshotEcsScope: scope }, records, '2026-10-10', '123456')).toBeNull();
  });
  it('queries from the original creation job rather than a late ledger observation', () => {
    const records = proof(); records.ledgers[0].billingStartAt = new Date('2026-10-09T00:30:00Z');
    expect(aliyunSnapshotHistoryStartAt(records.ledgers[0], records)?.toISOString()).toBe('2026-10-08T23:59:59.000Z');
  });
});

const rawEvent = (input: Partial<Record<string, unknown>> = {}) => ({ eventId: 'event-api', eventTime: '2026-10-09T01:00:01Z', eventName: 'CreateImage', eventType: 'ApiCall', eventCategory: 'Management', serviceName: 'Ecs',
  acsRegion: 'cn-hangzhou', userIdentity: { accountId: '123456', accessKeyId: 'should-never-be-stored' }, requestParameters: { instanceId: 'i-owned', password: 'should-never-be-stored' }, responseElements: { imageId: 'm-owned' }, ...input });
const query = (dependencies: Parameters<typeof collectAliyunSnapshotHistory>[2]) => collectAliyunSnapshotHistory(credentials,
  { sourceLedger: source(), sourceCreatedAt: new Date('2026-10-08T23:59:59Z'), billingDate: '2026-10-10' }, { now, pause: async () => {}, ...dependencies });

describe('Complete Alibaba snapshot audit collection', () => {
  it('follows every page without filtering by source ResourceName and stores no credentials or scripts', async () => {
    const calls: URLSearchParams[] = [];
    const fetcher = jest.fn(async (url: any) => {
      const params = new URL(String(url)).searchParams; calls.push(params);
      const next = params.get('NextToken');
      return new Response(JSON.stringify({ RequestId: next ? 'request-two' : 'request-one', StartTime: params.get('StartTime'), EndTime: params.get('EndTime'),
        Events: [rawEvent({ eventId: next ? 'event-two' : 'event-one' })], ...(next ? {} : { NextToken: 'page-two' }) }));
    });
    const value = await query({ fetch: fetcher as typeof fetch });
    expect(value?.requestIds).toEqual(['request-one', 'request-two']);
    expect(value?.events).toHaveLength(2);
    expect(calls[0].get('Version')).toBe('2020-07-06');
    expect(calls[0].get('LookupAttribute.1.Value')).toBe('Ecs');
    expect(calls[0].has('ResourceName')).toBe(false);
    expect(calls[0].has('LookupAttribute.2.Key')).toBe(false);
    expect(JSON.stringify(value)).not.toContain('should-never-be-stored');
  });
  it.each(['repeat-token', 'repeat-event', 'no-events', 'invalid-window', 'foreign-account', 'missing-region', 'invalid-token', 'http-error'])('returns pending on %s instead of throwing a sync error', async reason => {
    let count = 0;
    const fetcher = jest.fn(async (url: any) => {
      count++; const params = new URL(String(url)).searchParams;
      const body: any = { RequestId: `request-${count}`, StartTime: params.get('StartTime'), EndTime: params.get('EndTime'), Events: [rawEvent({ eventId: `event-${count}` })] };
      if (reason === 'repeat-token') body.NextToken = 'same-token';
      if (reason === 'repeat-event') { body.NextToken = count === 1 ? 'next' : undefined; body.Events[0].eventId = 'same-event'; }
      if (reason === 'no-events') { body.Events = []; body.NextToken = 'next'; }
      if (reason === 'invalid-window') body.StartTime = '2026-10-09T01:00:00Z';
      if (reason === 'foreign-account') body.Events[0].userIdentity.accountId = 'foreign';
      if (reason === 'missing-region') delete body.Events[0].acsRegion;
      if (reason === 'invalid-token') body.NextToken = 2;
      return new Response(JSON.stringify(body), { status: reason === 'http-error' ? 403 : 200 });
    });
    expect(await query({ fetch: fetcher as typeof fetch })).toBeNull();
  });
  it('refuses expired 90-day history and unsettled billing dates without making cloud calls', async () => {
    const fetcher = jest.fn();
    expect(await query({ now: () => new Date('2027-03-01'), fetch: fetcher })).toBeNull();
    expect(await query({ now: () => new Date('2026-10-10T16:00:00Z'), fetch: fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows the official numeric event IDs and ownerless system events from the authenticated account query', async () => {
    const value = await query({ fetch: (async (url: any) => { const params = new URL(String(url)).searchParams;
      return new Response(JSON.stringify({ RequestId: 'request-system', StartTime: params.get('StartTime'), EndTime: params.get('EndTime'),
        Events: [rawEvent({ eventId: '96.227_1606286128938_1', eventType: 'AliyunServiceEvent', userIdentity: { type: 'system' } })] })); }) as typeof fetch });
    expect(value?.events[0].id).toBe('96.227_1606286128938_1');
  });
  it('covers every 29-day window and permits only an identical event at their shared second', async () => {
    const calls: URLSearchParams[] = [];
    const fetcher = jest.fn(async (url: any) => {
      const params = new URL(String(url)).searchParams; calls.push(params);
      return new Response(JSON.stringify({ RequestId: `request-window-${calls.length}`, StartTime: params.get('StartTime'), EndTime: params.get('EndTime'),
        Events: [rawEvent({ eventId: 'event-boundary', eventTime: calls.length === 1 ? params.get('EndTime') : params.get('StartTime') })] }));
    });
    const value = await collectAliyunSnapshotHistory(credentials, { sourceLedger: source(), sourceCreatedAt: new Date('2026-09-01T00:00:00Z'), billingDate: '2026-10-10' }, { now, pause: async () => {}, fetch: fetcher as typeof fetch });
    expect(calls).toHaveLength(2);
    expect(calls[0].get('EndTime')).toBe(calls[1].get('StartTime'));
    expect(value?.events).toHaveLength(1);
    expect(value?.startAt).toBe('2026-09-01T00:00:00Z');
    expect(value?.endAt).toBe('2026-10-10T15:59:59Z');
  });
  it('does not trust an empty event list to establish the ECS birth or snapshot set', async () => {
    const value = await query({ fetch: (async (url: any) => { const params = new URL(String(url)).searchParams;
      return new Response(JSON.stringify({ RequestId: 'request-empty', StartTime: params.get('StartTime'), EndTime: params.get('EndTime'), Events: [] })); }) as typeof fetch });
    expect(value?.events).toEqual([]);
    expect(verify({ history: value })).toBeNull();
  });
});

function baselineFetch(calls: URLSearchParams[], mutate?: (action: string, body: any) => void) {
  return async (url: any) => {
    const params = new URL(String(url)).searchParams; calls.push(params);
    const action = params.get('Action')!;
    const body: any = { RequestId: `${action}-request`, TotalCount: 0 };
    if (action === 'DescribeAutoSnapshotPolicyEx') body.AutoSnapshotPolicies = { AutoSnapshotPolicy: [] };
    if (action === 'DescribeSnapshots') body.Snapshots = { Snapshot: [] };
    mutate?.(action, body);
    return new Response(JSON.stringify(body));
  };
}
describe('Submission-time Alibaba snapshot baseline', () => {
  it('captures complete source-disk and policy inventories, bound to the exact frozen identity', async () => {
    const calls: URLSearchParams[] = [];
    const value = await collectAliyunPackSnapshotBaseline(credentials, artifact(), { now, fetch: baselineFetch(calls) as typeof fetch });
    expect(value).toMatchObject({ kind: ALIYUN_PACK_SNAPSHOT_BASELINE_KIND, cloudAccountUid: '123456', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'],
      autoSnapshotPolicyIds: [], sourceDisks: [{ sourceDiskId: 'd-owned', snapshotIds: [], requestIds: ['DescribeSnapshots-request'] }] });
    expect(calls.map(params => params.get('Action'))).toEqual(['DescribeAutoSnapshotPolicyEx', 'DescribeSnapshots']);
    expect(readAliyunPackSnapshotBaseline({ ...artifact(), sourceSnapshotBaseline: value })).toEqual(value);
    expect(readAliyunPackSnapshotBaseline({ ...artifact(), sourceSnapshotBaseline: { ...value!, cloudAccountUid: 'foreign' } })).toBeNull();
  });
  it.each(['missing-total', 'count-gap', 'wrong-disk', 'duplicate-policy', 'inventory-error'])('returns null on %s without inventing an empty proof', async reason => {
    const fetcher = baselineFetch([], (action, body) => {
      if (reason === 'missing-total') delete body.TotalCount;
      if (reason === 'count-gap') body.TotalCount = 1;
      if (reason === 'wrong-disk' && action === 'DescribeSnapshots') { body.TotalCount = 1; body.Snapshots.Snapshot = [{ SnapshotId: 's-owned', SourceDiskId: 'd-foreign' }]; }
      if (reason === 'duplicate-policy' && action === 'DescribeAutoSnapshotPolicyEx') { body.TotalCount = 2; body.AutoSnapshotPolicies.AutoSnapshotPolicy = [{ AutoSnapshotPolicyId: 'sp-owned' }, { AutoSnapshotPolicyId: 'sp-owned' }]; }
      if (reason === 'inventory-error') body.Code = 'Forbidden';
    });
    expect(await collectAliyunPackSnapshotBaseline(credentials, artifact(), { now, fetch: fetcher as typeof fetch })).toBeNull();
  });
  it('preserves an observed external snapshot rather than dropping it from the baseline', async () => {
    const fetcher = baselineFetch([], (action, body) => {
      if (action === 'DescribeSnapshots') { body.TotalCount = 1; body.Snapshots.Snapshot = [{ SnapshotId: 's-foreign', SourceDiskId: 'd-owned' }]; }
    });
    const value = await collectAliyunPackSnapshotBaseline(credentials, artifact(), { now, fetch: fetcher as typeof fetch });
    expect(value?.sourceDisks[0].snapshotIds).toEqual(['s-foreign']);
  });
  it.each([true, false])('pack begin persists baseline when complete=%s while never creating or retrying cloud resources', async complete => {
    const repository = createMemoryAdminRepository();
    const context: CloudAccountContextCredentials = { id: 'ctx-owned', provider: 'alibaba_cloud', accountUid: '123456', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h',
      accessKeyId: 'mock-ak', accessKeySecret: 'mock-sk', imageImportBucket: '', status: 'ready' };
    const calls: URLSearchParams[] = [];
    const fetcher = baselineFetch(calls, (action, body) => {
      if (action === 'DescribeDisks') { body.TotalCount = 1; body.Disks = { Disk: [{ DiskId: 'd-owned' }] }; }
      if (!complete && action === 'DescribeAutoSnapshotPolicyEx') body.Code = 'Forbidden';
    });
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
    try {
      const service = new PackedImagesService(repository, {} as CloudAccountContextsService);
      const value = await service.begin({ cloudAccountContextId: 'ctx-owned', cloudAccountUid: '123456', regionId: 'cn-hangzhou', ownerUserId: 'user-owned', sourceRangeInstanceId: 'range-owned', sourceHostKey: 'ecs-owned', sourceInstanceId: 'i-owned' }, context);
      expect(Boolean(value.sourceSnapshotBaseline)).toBe(complete);
      expect(await repository.listPackedImageArtifacts()).toHaveLength(1);
      expect(calls.every(params => params.get('Action')?.startsWith('Describe'))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
