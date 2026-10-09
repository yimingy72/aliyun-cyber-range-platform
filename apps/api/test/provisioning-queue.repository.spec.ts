import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('provisioning queue repository', () => {
  it('pages pending jobs FIFO with an ID tie breaker, without snapshots or completed history', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T00:00:00Z'));
    try {
      const repository = createMemoryAdminRepository();
      const instance = await repository.createRangeInstance({ name: 'queued', status: 'pending_create' });
      const jobs = [];
      for (let index = 0; index < 12; index++) {
        jobs.push(await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'test' }));
      }
      await repository.updateProvisionJob(jobs[2].id, { status: 'succeeded' });
      await repository.updateProvisionJob(jobs[4].id, { status: 'running' });
      const first = await repository.listPendingProvisionJobs({ limit: 3 });
      const second = await repository.listPendingProvisionJobs({ limit: 100, after: first[2] });
      const expected = jobs.filter((_, index) => ![2, 4].includes(index)).map(job => job.id).sort();
      expect([...first, ...second].map(job => job.id)).toEqual(expected);
      expect(first).toHaveLength(3);
      expect(Object.keys(first[0]).sort()).toEqual(['cloudWorkspaceId', 'createdAt', 'id', 'jobType', 'rangeInstanceId', 'status']);
      expect(await repository.listPendingProvisionJobs({ after: second.at(-1) })).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  it('selects only expired live instances and omits credentials and topology JSON', async () => {
    const repository = createMemoryAdminRepository();
    const now = new Date('2026-10-09T01:00:00Z');
    const expected = [];
    for (const [mode, status, expiresAt] of [
      ['single', 'creating', now.toISOString()], ['single', 'running', now.toISOString()],
      ['range', 'running', now.toISOString()], ['range', 'creating', now.toISOString()],
      ['single', 'destroyed', now.toISOString()], ['single', 'running', '2026-10-10T01:00:00Z'],
      ['single', 'running', null],
    ] as const) {
      const instance = await repository.createRangeInstance({ name: `${mode}-${status}`, instanceMode: mode, status, expiresAt: expiresAt ?? undefined,
        runtimeCredentials: { host: { username: 'synthetic', password: 'synthetic-fixture-only' } } });
      if (expected.length < 3) expected.push(instance.id);
    }
    const expired = await repository.listExpiredRangeInstances(now);
    expect(expired.map(instance => instance.id).sort()).toEqual(expected.sort());
    const selected = await repository.listProvisioningInstancesByIds([expected[0], expected[0], 'missing']);
    expect(selected).toHaveLength(1);
    expect(Object.keys(selected[0]).sort()).toEqual(['cloudWorkspaceId', 'expiresAt', 'id', 'instanceMode', 'lastJobId', 'ownerUserId', 'singleInstanceBatchId', 'status']);
    expect(await repository.listProvisioningInstancesByIds([])).toEqual([]);
  });

  it('does not wait for a held batch lock, permits another batch and releases after success or failure', async () => {
    const repository = createMemoryAdminRepository();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = repository.tryWithSingleInstanceBatchProvisionLock('batch-a', () => gate);
    const work = jest.fn();
    expect(await repository.tryWithSingleInstanceBatchProvisionLock('batch-a', work)).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
    expect(await repository.tryWithSingleInstanceBatchProvisionLock('batch-b', async () => 7)).toEqual({ acquired: true, result: 7 });
    release();
    await first;
    await expect(repository.tryWithSingleInstanceBatchProvisionLock('batch-a', async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(await repository.tryWithSingleInstanceBatchProvisionLock('batch-a', async () => 8)).toEqual({ acquired: true, result: 8 });
  });

  it('loads only the requested batch and its complete membership', async () => {
    const repository = createMemoryAdminRepository();
    const batchInput = { name: 'batch', platformImageAssetId: 'asset', imageId: 'image', imageDisplayName: 'fixture', cpu: 2, memory: 2, systemDiskSize: 40, quantity: 2 };
    const batch = await repository.createSingleInstanceBatch(batchInput);
    const other = await repository.createSingleInstanceBatch(batchInput);
    const first = await repository.createRangeInstance({ name: 'first', instanceMode: 'single', status: 'running', singleInstanceBatchId: batch.id });
    const second = await repository.createRangeInstance({ name: 'second', instanceMode: 'single', status: 'destroyed', singleInstanceBatchId: batch.id });
    await repository.createRangeInstance({ name: 'other', instanceMode: 'single', singleInstanceBatchId: other.id });
    const result = await repository.getSingleInstanceBatchWithInstancesById(batch.id);
    expect(result?.instances.map(instance => instance.id).sort()).toEqual([first.id, second.id].sort());
    expect(result?.batch.id).toBe(batch.id);
    expect(await repository.getSingleInstanceBatchWithInstancesById('missing')).toBeNull();
  });

  it('makes a delayed refresh eligible at its deadline without delaying mutation jobs', async () => {
    const repository = createMemoryAdminRepository();
    const timestamp = new Date();
    const instance = await repository.createRangeInstance({ name: 'refresh', instanceMode: 'single', status: 'running' });
    const refresh = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'refresh_status', triggeredBy: 'synthetic', availableAt: new Date(timestamp.getTime() + 2000) });
    const destroy = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'synthetic' });
    expect((await repository.listPendingProvisionJobs({ now: new Date(timestamp.getTime() + 1000) })).map(job => job.id)).toEqual([destroy.id]);
    expect((await repository.listPendingProvisionJobs({ now: new Date(timestamp.getTime() + 2000) })).map(job => job.id).sort()).toEqual([refresh.id, destroy.id].sort());
  });

  it.each(['heartbeat', 'deadline'] as const)('aborts ongoing work on lease %s failure and clears timers', async failure => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockResolvedValue([{ acquired: true }]);
      const repository = new PrismaAdminRepository({ $transaction: (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: query }) } as never);
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const running = repository.tryWithSingleInstanceBatchProvisionLock('synthetic', async lease => {
        enter();
        return new Promise<void>((_, reject) => lease.signal.addEventListener('abort', () => reject(lease.signal.reason), { once: true }));
      });
      const rejected = expect(running).rejects.toThrow('lease');
      await entered;
      if (failure === 'heartbeat') query.mockRejectedValue(new Error('synthetic connection loss'));
      await jest.advanceTimersByTimeAsync(failure === 'heartbeat' ? 30_000 : 14 * 60_000);
      await rejected;
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('refuses assertions after a batch transaction ends', async () => {
    const query = jest.fn().mockResolvedValue([{ acquired: true }]);
    const repository = new PrismaAdminRepository({ $transaction: (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: query }) } as never);
    let assertHeld!: () => Promise<void>;
    let signal!: AbortSignal;
    await repository.tryWithSingleInstanceBatchProvisionLock('synthetic', async lease => { assertHeld = lease.assertHeld; signal = lease.signal; });
    expect(signal.aborted).toBe(true);
    await expect(assertHeld()).rejects.toThrow('lease has ended');
  });

  it('pushes bounded stable pending selection into PostgreSQL with a lightweight projection', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new PrismaAdminRepository({ provisionJob: { findMany } } as never);
    const cursor = { createdAt: new Date('2026-10-09T00:00:00Z'), id: 'cursor' };
    const now = new Date('2026-10-09T01:00:00Z');
    await repository.listPendingProvisionJobs({ after: cursor, limit: 40, now });
    expect(findMany).toHaveBeenCalledWith({ where: { status: 'pending', availableAt: { lte: now }, OR: [
      { createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ] }, take: 40, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: {
      cloudWorkspaceId: true, id: true, rangeInstanceId: true, jobType: true, status: true, createdAt: true,
    } });
    await repository.listPendingProvisionJobs();
    expect(findMany.mock.calls[1][0].take).toBe(100);
  });

  it.each([0, -1, 1001, 1.5, NaN])('rejects unbounded/invalid page size %s in both repositories', async limit => {
    const findMany = jest.fn();
    const prisma = new PrismaAdminRepository({ provisionJob: { findMany } } as never);
    await expect(prisma.listPendingProvisionJobs({ limit })).rejects.toThrow('page size');
    await expect(createMemoryAdminRepository().listPendingProvisionJobs({ limit })).rejects.toThrow('page size');
    expect(findMany).not.toHaveBeenCalled();
  });
});
