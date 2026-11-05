import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  return new ProvisioningWorkerService(createMemoryAdminRepository(), {} as never, {} as never);
}
const originalInterval = process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS;
beforeEach(() => { delete process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS; });
afterEach(() => {
  if (originalInterval === undefined) delete process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS;
  else process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS = originalInterval;
  jest.useRealTimers(); jest.restoreAllMocks();
});

describe('reconciliation cannot block expiry scheduling', () => {
  it('scans expiry and dispatches again while the startup cloud read is still unresolved', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z') });
    const worker = fixture(), cloud = gate(), stop = new Error('stop fixture loop');
    jest.spyOn(worker, 'recoverInterruptedJobs').mockResolvedValue(0);
    const expiry = jest.spyOn(worker, 'processExpiredInstances').mockResolvedValue(undefined);
    jest.spyOn(worker, 'reconcilePlatformResources').mockImplementation(async () => { await cloud.promise; return undefined as never; });
    const dispatch = jest.spyOn(worker as any, 'startEligiblePendingJobs').mockResolvedValueOnce(0).mockRejectedValue(stop);
    let failure: unknown;
    const loop = worker.runLoop().catch(error => { failure = error; });
    try {
      await jest.advanceTimersByTimeAsync(1_000);
      expect(expiry).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(failure).toBe(stop);
    } finally {
      cloud.resolve();
      await jest.advanceTimersByTimeAsync(1_000);
      await loop;
      await (worker as any).resourceReconciliationTask;
    }
  });

  it('keeps a single actual scan even when the hourly schedule is overdue', async () => {
    const worker = fixture(), cloud = gate();
    const now = new Date();
    const scan = jest.spyOn(worker, 'reconcilePlatformResources').mockImplementation(async () => { await cloud.promise; return undefined as never; });
    const scheduling = worker as any;
    scheduling.reconcilePlatformResourcesIfDue(now);
    const active = scheduling.resourceReconciliationTask;
    try {
      scheduling.reconcilePlatformResourcesIfDue(new Date(now.getTime() + 7_200_000));
      expect(scan).toHaveBeenCalledTimes(1);
      expect(scheduling.resourceReconciliationTask).toBe(active);
    } finally { cloud.resolve(); await active; }
    expect(scheduling.resourceReconciliationTask).toBeNull();
    scheduling.reconcilePlatformResourcesIfDue(new Date(now.getTime() + 7_200_000));
    await scheduling.resourceReconciliationTask;
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('contains a failed cloud read, redacts its message and releases the scan slot', async () => {
    const worker = fixture();
    const scan = jest.spyOn(worker, 'reconcilePlatformResources').mockRejectedValue(new Error('fixture-secret must never enter logs'));
    const log = jest.spyOn((worker as any).logger, 'error').mockImplementation(() => {});
    (worker as any).reconcilePlatformResourcesIfDue(new Date());
    await expect((worker as any).resourceReconciliationTask).resolves.toBeUndefined();
    expect((worker as any).resourceReconciliationTask).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-secret');
    (worker as any).reconcilePlatformResourcesIfDue(new Date(Date.now() + 3_600_000));
    await (worker as any).resourceReconciliationTask;
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, '0', '-1', 'invalid', 'Infinity'])('defaults to hourly patrol for interval %s', async value => {
    if (value !== undefined) process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS = value;
    const worker = fixture() as any;
    const scan = jest.spyOn(worker, 'reconcilePlatformResources').mockResolvedValue(undefined);
    const start = Date.parse('2026-10-19T00:00:00Z');
    worker.reconcilePlatformResourcesIfDue(new Date(start));
    await worker.resourceReconciliationTask;
    expect(worker.nextResourceReconciliationAt).toBe(start + 3_600_000);
    for (const elapsed of [300_000, 3_599_999]) worker.reconcilePlatformResourcesIfDue(new Date(start + elapsed));
    expect(scan).toHaveBeenCalledTimes(1);
    worker.reconcilePlatformResourcesIfDue(new Date(start + 3_600_000));
    await worker.resourceReconciliationTask;
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not retry failed patrols before the hourly slot', async () => {
    const worker = fixture() as any;
    const scan = jest.spyOn(worker, 'reconcilePlatformResources').mockRejectedValue(new Error('throttled fixture'));
    jest.spyOn(worker.logger, 'error').mockImplementation(() => {});
    const start = Date.now();
    worker.reconcilePlatformResourcesIfDue(new Date(start));
    await worker.resourceReconciliationTask;
    worker.reconcilePlatformResourcesIfDue(new Date(start + 300_000));
    expect(scan).toHaveBeenCalledTimes(1);
    worker.reconcilePlatformResourcesIfDue(new Date(start + 3_600_000));
    await worker.resourceReconciliationTask;
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('keeps supporting an explicit deployment interval override', async () => {
    process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS = '7200000';
    const worker = fixture() as any;
    jest.spyOn(worker, 'reconcilePlatformResources').mockResolvedValue(undefined);
    const now = new Date();
    worker.reconcilePlatformResourcesIfDue(now);
    await worker.resourceReconciliationTask;
    expect(worker.nextResourceReconciliationAt).toBe(now.getTime() + 7_200_000);
  });
});
