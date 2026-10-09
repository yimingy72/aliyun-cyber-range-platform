import { getCurrentCloudWorkspaceScope, runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { BillingSyncService } from '../src/admin/billing-sync.service';

describe('billing synchronization schedule', () => {
  const original = process.env.BILLING_SYNC_INTERVAL_MS;
  afterEach(() => {
    jest.useRealTimers();
    if (original === undefined) delete process.env.BILLING_SYNC_INTERVAL_MS;
    else process.env.BILLING_SYNC_INTERVAL_MS = original;
  });

  it('refreshes the previous and current months every six hours and stops on shutdown', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    process.env.BILLING_SYNC_INTERVAL_MS = '21600000';
    const service = new BillingSyncService({} as any, {} as any, {} as any);
    const sync = jest.spyOn(service, 'syncRecentDays').mockResolvedValue({} as any);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(21600000);
    expect(sync).toHaveBeenCalledWith(38);
    expect(sync).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(21600000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2027-01-01T00:00:00Z', 31],
    ['2028-03-01T00:00:00Z', 29],
    ['2026-10-31T16:00:00Z', 31],
  ])('covers month boundaries using the Shanghai billing day at %s', async (date, days) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(date));
    process.env.BILLING_SYNC_INTERVAL_MS = '1000';
    const service = new BillingSyncService({} as any, {} as any, {} as any);
    const sync = jest.spyOn(service, 'syncRecentDays').mockResolvedValue({} as any);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledWith(days);
    service.onModuleDestroy();
  });

  it('refreshes both verified providers with each frozen workspace/UID and excludes unverified spaces', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    process.env.BILLING_SYNC_INTERVAL_MS = '1000';
    const spaces = [{ id: 'ali', provider: 'alibaba_cloud' as const, accountUid: '100001', isReadOnly: false },
      { id: 'tencent', provider: 'tencent_cloud' as const, accountUid: '100001', isReadOnly: false },
      { id: 'tencent-other', provider: 'tencent_cloud' as const, accountUid: '200002', isReadOnly: false },
      { id: 'unknown', provider: 'tencent_cloud' as const, accountUid: null, isReadOnly: false },
      { id: 'historical', provider: 'tencent_cloud' as const, accountUid: '100001', isReadOnly: true }];
    const config = { listExecutionCloudWorkspaces: async () => spaces,
      runInWorkspace: async (id: string, work: () => Promise<unknown>) => {
        const space = spaces.find(item => item.id === id)!;
        return runInCloudWorkspace({ cloudWorkspaceId: id, provider: space.provider, accountUid: space.accountUid }, work);
      } };
    const service = new BillingSyncService({} as any, {} as any, config as any);
    const seen: unknown[] = [];
    const sync = jest.spyOn(service, 'syncRecentDays').mockImplementation(async days => { seen.push({ ...getCurrentCloudWorkspaceScope(), days }); return {} as any; });
    service.onModuleInit();
    try {
      await jest.advanceTimersByTimeAsync(1000);
      expect(sync).toHaveBeenCalledTimes(3);
      expect(seen).toEqual(spaces.slice(0, 3).map(space => ({ cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid, days: 38 })));
    } finally { service.onModuleDestroy(); }
  });

  it.each(['', '0', '-1', '0.5', 'not-a-number', '2147483648', '9007199254740992'])(
    'does not turn invalid or disabled interval %s into a rapid synchronization loop', async value => {
      jest.useFakeTimers();
      process.env.BILLING_SYNC_INTERVAL_MS = value;
      const service = new BillingSyncService({} as any, {} as any, {} as any);
      const sync = jest.spyOn(service, 'syncRecentDays').mockResolvedValue({} as any);
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60000);
      expect(sync).not.toHaveBeenCalled();
      service.onModuleDestroy();
    },
  );
});
