import { pumpLegacySingleInstanceWorker } from './support/legacy-single-instance-worker';

it('polls again when a delayed fixture becomes due after the scheduler snapshot', async () => {
  let finished = false;
  const queued = { id: 'queued', rangeInstanceId: 'member', status: 'pending', createdAt: new Date(), availableAt: new Date(Date.now() + 10) };
  const repository: any = { listProvisionJobs: async () => finished ? [] : [queued], getRangeInstanceById: async () => ({ instanceMode: 'single', singleInstanceConfig: { executionBackend: 'ecs-native' } }) };
  const worker: any = { activeTasks: new Set(), startEligiblePendingJobs: jest.fn()
    .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 0; })
    .mockImplementationOnce(async () => { finished = true; return 1; }) };
  await expect(pumpLegacySingleInstanceWorker(worker, repository)).resolves.toBeUndefined();
  expect(worker.startEligiblePendingJobs).toHaveBeenCalledTimes(2);
});
