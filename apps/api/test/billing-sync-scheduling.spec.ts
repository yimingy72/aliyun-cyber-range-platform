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
