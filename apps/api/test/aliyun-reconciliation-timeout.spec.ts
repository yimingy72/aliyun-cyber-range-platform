import { AliyunEcsResourceClient, PlatformResourceReconciliationService } from '../src/provisioning/platform-resource-reconciliation.service';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const credentials = { provider: 'alibaba_cloud' as const, accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret',
  regionId: 'cn-hangzhou', accountUid: '100001', cloudAccountContextId: 'fixture-context', accountUidResolved: true };
const config = { getExecutionAccountContext: async () => ({ ...credentials, defaultRegion: credentials.regionId }) } as unknown as SystemConfigService;
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

function hangingCloudRequest() {
  const controller = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  global.fetch = jest.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (!options?.signal) { reject(new Error('Cloud request has no deadline')); return; }
    options.signal.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  })) as typeof fetch;
  return { timeout, abort: () => controller.abort(new Error('Cloud inventory deadline exceeded')) };
}

describe('Aliyun reconciliation request deadlines', () => {
  it.each(['describe', 'list', 'tag'] as const)('cancels a stalled %s request rather than blocking the caller indefinitely', async operation => {
    const { timeout, abort } = hangingCloudRequest();
    const client = new AliyunEcsResourceClient(config);
    const pending = operation === 'describe' ? client.describeInstances(credentials, ['i-fixture'])
      : operation === 'list' ? client.listPlatformManagedInstances(credentials)
      : client.tagResources({ credentials, resourceType: 'disk', resourceIds: ['d-fixture'], tags: { CreatedBy: 'cyber-range-platform' } });
    const rejected = expect(pending).rejects.toThrow('Cloud inventory deadline exceeded');
    abort();
    await rejected;
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it('propagates an interrupted inventory read without changing lifecycle, bills or drift evidence', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'expired-but-not-verified', instanceMode: 'range', status: 'running',
      expiresAt: '2026-01-01T00:00:00Z', resourceSummary: { mode: 'opentofu', hostIds: { entry: 'i-fixture' } } });
    const ledger = await repository.createBillingLedgerResource({ rangeInstanceId: instance.id, cloudAccountUid: credentials.accountUid,
      cloudResourceId: 'i-fixture', cloudResourceType: 'ecs', regionId: credentials.regionId, billingScope: 'platform', billingStartAt: instance.createdAt });
    const drift = jest.spyOn(repository, 'upsertCloudResourceDrift');
    const resolved = jest.spyOn(repository, 'resolveCloudResourceDrift');
    const { abort, timeout } = hangingCloudRequest();
    const service = new PlatformResourceReconciliationService(repository, new AliyunEcsResourceClient(config));
    const pending = expect(service.reconcile()).rejects.toThrow('Cloud inventory deadline exceeded');
    // Credential resolution and inventory scheduling are asynchronous; let the mocked reads start.
    for (let turn = 0; turn < 10 && !(global.fetch as jest.Mock).mock.calls.length; turn++) await Promise.resolve();
    abort();
    await pending;
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(await repository.getRangeInstanceById(instance.id)).toEqual(instance);
    expect(await repository.listBillingLedgerResources()).toEqual([ledger]);
    expect(drift).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
  });
});
