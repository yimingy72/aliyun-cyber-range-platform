import { readAliyunResourceCloudEvents } from '../src/admin/aliyun-resource-cloud-events';

const now = new Date('2026-11-02T07:00:00Z');
const context: any = { provider: 'alibaba_cloud', cloudAccountContextId: 'context-1', accountUid: '100001', accountUidResolved: true,
  defaultRegion: 'cn-beijing', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const ledger: any = { cloudResourceId: 'i-owned', cloudResourceType: 'ecs', cloudAccountUid: '100001', regionId: 'cn-beijing',
  billingStartAt: new Date('2026-10-20T03:33:58Z'), releasedAt: new Date('2026-10-28T02:13:33Z'), tagsSnapshot: { CloudAccountContextId: 'context-1' } };
const event = (overrides = {}) => ({ eventId: 'event-delete', eventTime: '2026-10-20T14:03:00Z', eventName: 'DeleteInstance',
  eventType: 'ApiCall', serviceName: 'Ecs', eventRW: 'Write', recipientAccountId: '100001', acsRegion: 'cn-beijing', requestId: 'native-delete-request',
  requestParameters: { instanceId: 'i-owned', password: 'private-password', UserData: 'private-script' }, ...overrides });
function deps(events: any[] = [event()], extra = {}) {
  const fetch = jest.fn(async (input: any) => {
    const query = new URL(String(input)).searchParams;
    return new Response(JSON.stringify({ RequestId: 'audit-query', StartTime: query.get('StartTime'), EndTime: query.get('EndTime'), Events: events, ...extra }));
  });
  return { fetch: fetch as typeof globalThis.fetch, pause: async () => {}, now: () => now };
}

describe('native cloud resource event evidence', () => {
  it('queries only the recorded ID and time window and projects write events without credentials or raw arguments', async () => {
    const d = deps([event(), event({ eventId: 'read-event', eventName: 'DescribeInstances', eventRW: 'Read' })]);
    const result = await readAliyunResourceCloudEvents(context, ledger, d);
    expect(result).toMatchObject({ complete: true, errorCode: null, requestIds: ['audit-query'], events: [{
      eventName: 'DeleteInstance', eventTime: '2026-10-20T14:03:00.000Z', parameters: { InstanceId: 'i-owned' }, errorCode: null,
    }] });
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/fixture-key|fixture-secret|private-password|private-script|requestParameters/);
    const query = new URL(String((d.fetch as jest.Mock).mock.calls[0][0])).searchParams;
    expect(query.get('Action')).toBe('LookupEvents'); expect(query.get('Version')).toBe('2020-07-06');
    expect(query.get('LookupAttribute.1.Key')).toBe('ResourceName'); expect(query.get('LookupAttribute.1.Value')).toBe('i-owned');
    expect(query.get('StartTime')).toBe('2026-10-20T03:28:58Z'); expect(query.get('EndTime')).toBe('2026-10-28T02:18:33Z');
  });
  it.each([{ accountUid: 'other' }, { cloudAccountContextId: 'other' }, { defaultRegion: 'cn-hangzhou' }, { accountUidResolved: false }, { provider: 'tencent_cloud' }])
    ('rejects an account or region mismatch before calling the cloud: %j', async change => {
      const d = deps(); const result = await readAliyunResourceCloudEvents({ ...context, ...change }, ledger, d);
      expect(result.complete).toBe(false); expect(d.fetch).not.toHaveBeenCalled();
    });
  it.each([{ recipientAccountId: 'other' }, { acsRegion: 'cn-hangzhou' }, { eventTime: '2026-10-19T00:00:00Z' }])
    ('does not adopt a page containing foreign or out-of-window events: %j', async change => {
      const result = await readAliyunResourceCloudEvents(context, ledger, deps([event(change)]));
      expect(result.complete).toBe(false); expect(result.errorCode).toBe('CLOUD_EVENTS_INCOMPLETE');
    });
  it('retains a failed delete as a failure and never treats an empty lookup as proof of deletion', async () => {
    const failed = await readAliyunResourceCloudEvents(context, ledger, deps([event({ errorCode: 'OperationConflict' })]));
    expect(failed.events[0].errorCode).toBe('OperationConflict');
    expect(await readAliyunResourceCloudEvents(context, ledger, deps([]))).toMatchObject({ complete: true, events: [] });
  });
  it('rejects repeated pages and does not expose cloud response messages', async () => {
    const repeated = await readAliyunResourceCloudEvents(context, ledger, deps([event()], { NextToken: 'same-token' }));
    expect(repeated.complete).toBe(false);
    const d = deps(); d.fetch = jest.fn(async () => new Response(JSON.stringify({ Code: 'Forbidden', Message: 'fixture-secret' }), { status: 403 })) as any;
    const rejected = await readAliyunResourceCloudEvents(context, ledger, d);
    expect(rejected).toMatchObject({ complete: false, errorCode: 'Forbidden' }); expect(JSON.stringify(rejected)).not.toContain('fixture-secret');
  });
});
