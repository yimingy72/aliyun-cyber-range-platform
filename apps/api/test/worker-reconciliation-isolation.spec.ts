import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  return new ProvisioningWorkerService(createMemoryAdminRepository(), {} as never, {} as never);
}
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

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

  it('keeps a single actual scan even when operations invalidate the next scan time', async () => {
    const worker = fixture(), cloud = gate();
    const scan = jest.spyOn(worker, 'reconcilePlatformResources').mockImplementation(async () => { await cloud.promise; return undefined as never; });
    const scheduling = worker as any;
    scheduling.reconcilePlatformResourcesIfDue(new Date());
    const active = scheduling.resourceReconciliationTask;
    try {
      scheduling.nextResourceReconciliationAt = 0;
      scheduling.reconcilePlatformResourcesIfDue(new Date(Date.now() + 3_600_000));
      expect(scan).toHaveBeenCalledTimes(1);
      expect(scheduling.resourceReconciliationTask).toBe(active);
    } finally { cloud.resolve(); await active; }
    expect(scheduling.resourceReconciliationTask).toBeNull();
    scheduling.reconcilePlatformResourcesIfDue(new Date());
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
});
