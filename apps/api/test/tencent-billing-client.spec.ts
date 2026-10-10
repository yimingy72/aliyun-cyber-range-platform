import { TencentBillingClient, type TencentBillingContext } from '../src/admin/tencent-billing-client';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';

jest.mock('../src/admin/tencent-cloud-client', () => ({ requestTencentCloud: jest.fn() }));
const request = requestTencentCloud as jest.Mock;
const MONTH = '2026-09';
const context: TencentBillingContext = { provider: 'tencent_cloud', accountUid: '100001', accountUidResolved: true,
  accessKeyId: 'test-key', accessKeySecret: 'test-secret' };
const row = (overrides: Record<string, unknown> = {}) => ({ Id: 'bill-1', OwnerUin: context.accountUid, PayerUin: context.accountUid,
  BillDay: `${MONTH}-30 00:00:00`, BillMonth: `${MONTH}-01 00:00:00`, ResourceId: 'ins-owned', RegionId: '4',
  ComponentSet: [{ RealCost: '0.10000001', CashPayAmount: '999', Cost: '9999' }, { RealCost: '-0.00000001', VoucherPayAmount: '1' }], ...overrides });
const response = (rows: unknown[] = [row()], overrides: Record<string, unknown> = {}) => ({ DetailSet: rows, Total: rows.length, ...overrides });
const query = () => new TencentBillingClient().listMonthlyBillingItems({ month: MONTH }, context);
afterEach(() => jest.resetAllMocks());

describe('Tencent billing source client', () => {
  it('queries the domestic monthly official source and keeps exact discounted components including refunds', async () => {
    request.mockResolvedValue(response());
    expect(await query()).toEqual([expect.objectContaining({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001',
      billingMonth: MONTH, billingDate: `${MONTH}-30`, billingRegionId: '4', cloudResourceId: 'ins-owned',
      sourceId: 'bill-1', discountedAmount: '0.1', currency: 'CNY',
      rawPayload: expect.objectContaining({ __platformCloudProvider: 'tencent_cloud', __platformBillingSource: 'DescribeBillDetail' }) })]);
    expect(request).toHaveBeenCalledWith({ service: 'billing', version: '2018-07-09', action: 'DescribeBillDetail',
      accessKeyId: 'test-key', accessKeySecret: 'test-secret', parameters: { Month: MONTH, PayerUin: '100001', Offset: 0, Limit: 300, NeedRecordNum: 1 } });
    request.mockResolvedValue(response([row({ ComponentSet: [{ RealCost: '-0.10000001' }, { RealCost: '-0.00000001' }] })]));
    expect((await query())[0].discountedAmount).toBe('-0.10000002');
  });

  it('reads beyond a stale undercounted Total until the short final page and carries the optional query context', async () => {
    const first = Array.from({ length: 300 }, (_, index) => row({ Id: `bill-${index}` }));
    request.mockResolvedValueOnce(response(first, { Total: 299, Context: 'opaque-query-context' }))
      .mockResolvedValueOnce(response([row({ Id: 'bill-final' })], { Total: 299 }));
    expect(await query()).toHaveLength(301);
    expect(request.mock.calls[1][0].parameters).toEqual({ Month: MONTH, PayerUin: '100001', Offset: 300, Limit: 300,
      NeedRecordNum: 1, Context: 'opaque-query-context' });
  });

  it('confirms an exactly full page with one additional empty page rather than truncating at Total', async () => {
    request.mockResolvedValueOnce(response(Array.from({ length: 300 }, (_, index) => row({ Id: `bill-${index}` })), { Total: 300 }))
      .mockResolvedValueOnce(response([], { Total: 300 }));
    expect(await query()).toHaveLength(300);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockReset().mockResolvedValue(response([]));
    expect(await query()).toEqual([]);
  });

  it('freezes account credentials across pagination even if the caller changes its context', async () => {
    const mutable = { ...context };
    request.mockImplementationOnce(async () => {
      mutable.accountUid = '200002'; mutable.accessKeyId = 'different-key'; mutable.accessKeySecret = 'different-secret';
      return response(Array.from({ length: 300 }, (_, index) => row({ Id: `bill-${index}` })), { Total: 301 });
    }).mockResolvedValueOnce(response([row({ Id: 'last' })], { Total: 301 }));
    await new TencentBillingClient().listMonthlyBillingItems({ month: MONTH }, mutable);
    expect(request.mock.calls[1][0]).toMatchObject({ accessKeyId: 'test-key', accessKeySecret: 'test-secret', parameters: { PayerUin: '100001' } });
  });

  it.each([
    { OwnerUin: '200002' }, { OwnerUin: undefined }, { PayerUin: '200002' }, { PayerUin: undefined },
    { Id: undefined }, { ResourceId: '' }, { RegionId: 'ap-guangzhou' }, { RegionId: 4 },
    { BillDay: '2026-08-30 00:00:00' }, { BillDay: '2026-09-31 00:00:00' }, { BillDay: undefined },
    { BillMonth: '2026-09-02 00:00:00' }, { Currency: 'USD' }, { ComponentSet: [] }, { ComponentSet: [null] },
    { ComponentSet: [{ RealCost: NaN }] }, { ComponentSet: [{ RealCost: 'NaN' }] },
    { ComponentSet: [{ RealCost: '1e4' }] }, { ComponentSet: [{ Cost: '1' }] },
  ])('rejects incomplete, different-account or invalid financial evidence %j', async overrides => {
    request.mockResolvedValue(response([row(overrides)]));
    await expect(query()).rejects.toThrow();
  });

  it.each([{ Total: null }, { Total: undefined }, { Total: -1 }, { Total: 0.5 }, { Total: 2 },
    { DetailSet: undefined }, { DetailSet: [null] }, { Context: 1 }])('does not return partial data for invalid page metadata %j', async overrides => {
    request.mockResolvedValue(response([row()], overrides));
    await expect(query()).rejects.toThrow();
  });

  it('rejects changing totals, duplicate record IDs and a failed later page', async () => {
    const first = response(Array.from({ length: 300 }, (_, index) => row({ Id: `bill-${index}` })), { Total: 301 });
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(response([row({ Id: 'new' })], { Total: 302 }));
    await expect(query()).rejects.toThrow('changing row count');
    request.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(response([row({ Id: 'bill-0' })], { Total: 301 }));
    await expect(query()).rejects.toThrow('repeated');
    request.mockReset().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('upstream request failed'));
    await expect(query()).rejects.toThrow('upstream request failed');
  });

  it.each(['alibaba_cloud', 'other_cloud', ''])('rejects provider %s without invoking any cloud request', async provider => {
    await expect(new TencentBillingClient().listMonthlyBillingItems({ month: MONTH }, { ...context, provider })).rejects.toThrow('Tencent cloud account');
    expect(request).not.toHaveBeenCalled();
  });

  it('validates month and verified account UIN before sending credentials', async () => {
    await expect(new TencentBillingClient().listMonthlyBillingItems({ month: '2026-13' }, context)).rejects.toThrow('month');
    await expect(new TencentBillingClient().listMonthlyBillingItems({ month: MONTH }, { ...context, accountUidResolved: false })).rejects.toThrow('verified');
    await expect(new TencentBillingClient().listMonthlyBillingItems({ month: MONTH }, { ...context, accountUid: null })).rejects.toThrow('verified');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { value: ' \t ', shape: 'blank_string' },
    { value: 'USD', shape: 'iso_like_non_cny' }, { value: 'ZZZ', shape: 'iso_like_non_cny' },
    { value: 'cny', shape: 'cny_noncanonical' }, { value: 'usd', shape: 'iso_like_noncanonical' },
    { value: 'fixture-private-currency-url?secret=fixture-only', shape: 'non_iso_string' },
    { value: 123456789, shape: 'number' }, { value: true, shape: 'boolean' },
    { value: ['CNY'], shape: 'array' }, { value: { private: 'fixture-secret' }, shape: 'object' },
  ])('classifies component currency safely as $shape without accepting unknown financial evidence', async ({ value, shape }) => {
    request.mockResolvedValue(response([row({ ComponentSet: [{ RealCost: '1.123456789', Currency: value }] })]));
    await expect(query()).rejects.toThrow(`unsupported component currency (shape=${shape}; expected=CNY; source=domestic); previous bills were retained`);
  });

  it.each(['', null, undefined, 'CNY'])('keeps domestic yuan and signed exact RealCost amounts when row/component Currency is %j', async Currency => {
    const bill = row();
    request.mockResolvedValue(response([{ ...bill, Currency, ComponentSet: bill.ComponentSet.map(component => ({ ...component, Currency })) }]));
    expect(await query()).toEqual([expect.objectContaining({ currency: 'CNY', discountedAmount: '0.1' })]);
  });

  it('uses the same bounded row diagnostic and never includes arbitrary values, amounts or resource IDs', async () => {
    const privateValue = 'fixture-private-currency-url?secret=fixture-only';
    request.mockResolvedValue(response([row({ Currency: privateValue, ResourceId: 'ins-private-fixture', ComponentSet: [{ RealCost: '1.123456789' }] })]));
    const error = await query().catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('DescribeBillDetail returned an unsupported row currency (shape=non_iso_string; expected=CNY; source=domestic); previous bills were retained');
    for (const value of [privateValue, '1.123456789', 'ins-private-fixture', 'test-secret']) expect((error as Error).message).not.toContain(value);
  });
});
