import { BillingBssClient, BillingSplitBillUnavailableError } from '../src/admin/billing-bss-client';
import type { SystemCloudAccountContext, SystemConfigService } from '../src/admin/system-config.service';

const DAY = '2026-10-01';
const context = { provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true, cloudAccountContextId: 'test-cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'test-key', accessKeySecret: 'test-secret', imageImportBucket: 'test-bucket' } as SystemCloudAccountContext;
const config = { getAccountContext: jest.fn(async () => context) } as unknown as SystemConfigService;
const originalFetch = global.fetch;
const row = (overrides: Record<string, unknown> = {}) => ({ OwnerID: context.accountUid, SplitAccountID: context.accountUid, SplitBillingDate: DAY, SplitBillingCycle: '2026-10', ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', SplitItemID: 'i-platform', PretaxAmount: '0.123456789', Currency: 'CNY', Item: 'PayAsYouGoBill', ...overrides });
const payload = (items: unknown[] = [row()], extra: Record<string, unknown> = {}) => ({ Success: true, Code: 'Success', Data: { AccountID: context.accountUid, BillingCycle: '2026-10', Items: items, TotalCount: items.length, ...extra } });
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const client = () => new BillingBssClient(config);
const query = { billingDate: DAY, productCode: 'snapshot' as const };
afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

describe('split billing source contract', () => {
  it('reads every page with a frozen account and preserves original bill identifiers and precision', async () => {
    const first = row(); const second = row({ SplitItemID: 'i-second', PretaxAmount: '-0.01', Item: 'Refund' });
    global.fetch = jest.fn().mockResolvedValueOnce(response(payload([first], { TotalCount: 2, NextToken: 'page-2' })))
      .mockResolvedValueOnce(response(payload([second], { TotalCount: 2 })));
    expect(await client().listDailySplitBillingItems(query, context)).toEqual([first, second]);
    expect(config.getAccountContext).not.toHaveBeenCalled();
    const parameters = (global.fetch as jest.Mock).mock.calls.map(([url]) => new URL(url).searchParams);
    expect(parameters[0].get('Action')).toBe('DescribeSplitItemBill');
    expect(parameters[0].get('BillOwnerId')).toBe(context.accountUid);
    expect(parameters[0].get('ProductCode')).toBe('snapshot');
    expect(parameters[0].get('Granularity')).toBe('DAILY');
    expect(parameters[0].get('BillingDate')).toBe(DAY);
    expect(parameters[0].get('MaxResults')).toBe('300');
    expect(parameters[0].has('IsBillingItem')).toBe(false);
    expect(parameters[1].get('NextToken')).toBe('page-2');
  });

  it('accepts explicit zero rows and queries OSS bucket split identifiers unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(payload([]))).mockResolvedValueOnce(response(payload([row({ ProductCode: 'oss', SplitItemID: 'test-bucket', BillingDate: 'unsupported-value' })])));
    expect(await client().listDailySplitBillingItems(query)).toEqual([]);
    expect(await client().listDailySplitBillingItems({ billingDate: DAY, productCode: 'oss' })).toEqual([row({ ProductCode: 'oss', SplitItemID: 'test-bucket', BillingDate: 'unsupported-value' })]);
  });

  it.each([
    { Data: undefined },
    { AccountID: '100002' }, { AccountID: undefined }, { BillingCycle: '2026-09' },
    { TotalCount: undefined }, { TotalCount: -1 }, { TotalCount: 0.5 }, { TotalCount: 2 },
    { Items: [null] }, { Items: undefined }, { NextToken: 5 },
    { Items: [row({ OwnerID: '100002' })] }, { Items: [row({ SplitAccountID: '100002' })] },
    { Items: [row({ SplitBillingDate: undefined })] }, { Items: [row({ SplitBillingDate: '2026-09-30' })] },
    { Items: [row({ SplitBillingCycle: '2026-09' })] }, { Items: [row({ ProductCode: 'oss' })] },
  ])('rejects malformed, incomplete, wrong-account or wrong-day data %j', async extra => {
    const body = 'Data' in extra ? { ...payload(), ...extra } : payload([row()], extra);
    global.fetch = jest.fn().mockResolvedValue(response(body));
    await expect(client().listDailySplitBillingItems(query)).rejects.toThrow();
  });

  it('rejects changing totals and a repeated token without returning partial results', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(payload([row()], { TotalCount: 3, NextToken: 'page-2' })))
      .mockResolvedValueOnce(response(payload([row()], { TotalCount: 2 })));
    await expect(client().listDailySplitBillingItems(query)).rejects.toThrow('inconsistent row count');
    global.fetch = jest.fn().mockResolvedValue(response(payload([row()], { TotalCount: 3, NextToken: 'repeat' })));
    await expect(client().listDailySplitBillingItems(query)).rejects.toThrow('pagination token');
  });

  it('does not replace a failed later page, unenabled service or denied permission with an empty bill', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(payload([row()], { TotalCount: 2, NextToken: 'page-2' })))
      .mockRejectedValueOnce(new Error('network failure'));
    await expect(client().listDailySplitBillingItems(query)).rejects.toThrow('network failure');
    global.fetch = jest.fn().mockResolvedValue(response({ Success: false, Code: 'Forbidden', Message: 'private upstream detail' }));
    const error = await client().listDailySplitBillingItems(query).catch(value => value);
    expect(error).toBeInstanceOf(BillingSplitBillUnavailableError);
    expect(error.code).toBe('Forbidden');
    expect(error.message).not.toContain('private upstream detail');
  });

  it('validates the query and the verified cloud identity before fetching', async () => {
    global.fetch = jest.fn();
    await expect(client().listDailySplitBillingItems({ ...query, billingDate: '2026-02-30' })).rejects.toThrow('Invalid split');
    await expect(client().listDailySplitBillingItems(query, { ...context, accountUidResolved: false })).rejects.toThrow('已验证');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
