import { readAliyunResourceConfigTimelines } from '../src/admin/aliyun-resource-config-timeline';
const now = new Date('2026-11-03T02:00:00Z');
const context: any = { provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true, defaultRegion: 'cn-beijing',
  cloudAccountContextId: 'context', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const ledger: any = { cloudAccountUid: context.accountUid, regionId: context.defaultRegion, cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
  billingStartAt: new Date('2026-10-20T03:30:00Z'), releasedAt: new Date('2026-10-28T02:13:33Z'), tagsSnapshot: { CloudAccountContextId: 'context' } };
const record = { AccountId: context.accountUid, Region: context.defaultRegion, ResourceId: ledger.cloudResourceId, ResourceType: 'ACS::ECS::Instance',
  ResourceEventType: 'REMOVE', CaptureTime: String(Date.parse('2026-10-20T14:10:00Z')), ResourceCreateTime: String(Date.parse('2026-10-20T03:39:00Z')),
  ConfigurationDiff: 'private secret script', Tags: 'fixture-secret' };
const response = (timeline: any): any => ({ ok: true, json: async () => ({ RequestId: 'request-config', ResourceConfigurationTimeline: timeline }) });
const dependencies = (fetch: any) => ({ fetch, pause: async () => {}, now: () => now });

it('projects only exact owner/region/resource capture timestamps, with full pagination and no ActionTrail requests', async () => {
  const fetch = jest.fn().mockResolvedValueOnce(response({ MaxResults: 100, ConfigurationList: [record], NextToken: 'page-2' }))
    .mockResolvedValueOnce(response({ MaxResults: 100, ConfigurationList: [{ ...record, CaptureTime: String(Date.parse('2026-10-20T03:40:00Z')), ResourceEventType: 'DISCOVERED' }] }));
  const result = await readAliyunResourceConfigTimelines(context, [ledger], dependencies(fetch));
  expect(result).toMatchObject({ complete: true, resources: [{ complete: true, records: [
    { resourceEventType: 'REMOVE', captureTime: '2026-10-20T14:10:00.000Z' }, { resourceEventType: 'DISCOVERED' },
  ] }] });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|ConfigurationDiff|Tags/);
  for (const [url] of fetch.mock.calls) {
    const parsed = new URL(url); expect(parsed.hostname).toBe('config.cn-shanghai.aliyuncs.com');
    expect(parsed.searchParams.get('Action')).toBe('GetResourceConfigurationTimeline'); expect(parsed.searchParams.get('ResourceId')).toBe('i-owned');
    expect(parsed.searchParams.get('Version')).toBe('2020-09-07'); expect(parsed.searchParams.get('MaxResults')).toBe('100');
    expect(parsed.searchParams.has('Limit')).toBe(false);
  }
});
it('stops after one permission denial and preserves unqueried resources without enabling services', async () => {
  const fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ Code: 'NoPermission', RequestId: 'request-denied', Message: context.accessKeySecret }) });
  const result = await readAliyunResourceConfigTimelines(context, [ledger, { ...ledger, cloudResourceId: 'd-owned', cloudResourceType: 'disk' }], dependencies(fetch));
  expect(result).toMatchObject({ complete: false, resources: [{ errorCode: 'NoPermission', requestIds: ['request-denied'] }], unqueriedResourceIds: ['d-owned'] });
  expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain(context.accessKeySecret);
});
it.each([
  { ...record, AccountId: 'foreign' }, { ...record, Region: 'cn-hangzhou' }, { ...record, ResourceId: 'i-foreign' },
  { ...record, ResourceType: 'ACS::EIP::EipAddress' }, { ...record, CaptureTime: '0' }, { ...record, ResourceEventType: 'private script' },
])('rejects foreign or malformed config records without projecting their raw body: %j', async bad => {
  const fetch = jest.fn().mockResolvedValue(response({ TotalCount: 1, ConfigurationList: [bad] }));
  expect(await readAliyunResourceConfigTimelines(context, [ledger], dependencies(fetch))).toMatchObject({ complete: false, resources: [{ complete: false, errorCode: 'CONFIG_TIMELINE_INCOMPLETE' }] });
});
it('does not interpret a complete empty timeline as a deletion record', async () => {
  const fetch = jest.fn().mockResolvedValue(response({ MaxResults: 100, ConfigurationList: [] }));
  expect(await readAliyunResourceConfigTimelines(context, [ledger], dependencies(fetch))).toMatchObject({ complete: true, resources: [{ records: [] }] });
});
it.each([{ ...ledger, cloudAccountUid: 'foreign' }, { ...ledger, tagsSnapshot: {} }, { ...ledger, billingStartAt: new Date('2020-01-01') }])('rejects unverified or out-of-window scope before fetching', async row => {
  const fetch = jest.fn(); const result = await readAliyunResourceConfigTimelines(context, [row], dependencies(fetch));
  expect(result.complete).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
it('requires an explicit bounded selection and rejects incomplete pages', async () => {
  const fetch = jest.fn().mockResolvedValue(response({ TotalCount: 1, ConfigurationList: [] }));
  expect(await readAliyunResourceConfigTimelines(context, Array.from({ length: 21 }, (_, n) => ({ ...ledger, cloudResourceId: 'i-' + n })), dependencies(fetch)))
    .toMatchObject({ complete: false, reasonCode: 'SELECT_1_TO_20_RESOURCES' });
  expect(fetch).not.toHaveBeenCalled();
  expect(await readAliyunResourceConfigTimelines(context, [ledger], dependencies(fetch))).toMatchObject({ complete: false, resources: [{ errorCode: 'CONFIG_TIMELINE_INCOMPLETE' }] });
});
