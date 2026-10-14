import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { imageRpc } from '../src/admin/aliyun-image-rpc';
import { resolveAliyunWindowsDnsHostImages } from '../src/provisioning/open-tofu-range-provisioner';
import { expiredSingleDestroyDecision } from '../src/provisioning/automatic-destroy-policy';

const credentials = { accessKeyId: 'SyntheticCloudKey0123456789', accessKeySecret: 'SyntheticCloudSecret0123456789', regionId: 'cn-test' };
const rpcInput = { ...credentials, action: 'DescribeInstances', parameters: {} };
type Rpc = { performAliyunRpcRequest: (input: typeof rpcInput) => Promise<unknown> };

function invoke(kind: 'native' | 'system' | 'range' | 'sts' | 'image') {
  if (kind === 'native') return (new SingleInstanceBatchExecutionService({} as never, {} as never) as unknown as Rpc).performAliyunRpcRequest(rpcInput);
  if (kind === 'system') return (new SystemConfigService({} as never, {} as never) as unknown as Rpc).performAliyunRpcRequest(rpcInput);
  if (kind === 'image') return imageRpc(credentials, 'DescribeImages');
  if (kind === 'sts') return (new CloudAccountContextsService({} as never) as unknown as { resolveAccountUid: (key: string, secret: string) => Promise<string> }).resolveAccountUid(credentials.accessKeyId, credentials.accessKeySecret);
  return resolveAliyunWindowsDnsHostImages({ hosts: [{ key: 'host', dns: { servers: ['10.0.0.1'] } }], hostImageIds: { host: 'm-fixture' },
    fallbackImageId: 'm-fixture', runtimeConfig: { ...credentials, provider: 'alibaba_cloud', defaultRegion: 'cn-test', defaultZoneId: 'cn-test-a' },
  } as unknown as Parameters<typeof resolveAliyunWindowsDnsHostImages>[0]);
}

describe('Aliyun RPC error and timeout boundaries', () => {
  const originalFetch = global.fetch;
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it.each(['system', 'range', 'image'] as const)('keeps provider messages out of %s errors and rejects reflected credentials in Code', async kind => {
    for (const status of [403, 200]) {
      for (const code of ['Forbidden', `Forbidden.${credentials.accessKeyId}`, `Forbidden.${credentials.accessKeySecret}`]) {
        global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ Code: code, Message: `echo ${credentials.accessKeySecret}` }), { status })) as typeof fetch;
        const error = await invoke(kind).catch(value => value) as Error;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(credentials.accessKeyId);
        expect(error.message).not.toContain(credentials.accessKeySecret);
        expect(error.message).not.toContain('echo');
        if (code === 'Forbidden') expect(error.message).toContain('Forbidden');
      }
    }
  });

  it.each(['native', 'system', 'range', 'sts'] as const)('terminates a stalled %s HTTP request', async kind => {
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(20));
    global.fetch = jest.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    const error = await invoke(kind).catch(value => value) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(timeout).toHaveBeenCalledWith(kind === 'sts' ? 15_000 : 30_000);
  });

  it.each(['native', 'system', 'range'] as const)('preserves %s response-body timeout for safe automatic cleanup retries', async kind => {
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(20));
    global.fetch = jest.fn().mockImplementation(async (_url, init: RequestInit) => ({ ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })),
    })) as typeof fetch;
    const error = await invoke(kind).catch(value => value) as Error;
    expect(error.message).toMatch(/timeout|timed out/i);
    const finishedAt = new Date('2026-10-14T00:00:00Z');
    expect(expiredSingleDestroyDecision({ id: 'single', instanceMode: 'single', status: 'destroy_failed', expiresAt: finishedAt, lastJobId: 'destroy',
      singleInstanceConfig: { cloudAccountContextId: 'context', cloudAccountUid: '100001', regionId: 'cn-test' },
    }, { id: 'destroy', rangeInstanceId: 'single', jobType: 'destroy', status: 'failed', triggeredBy: 'system:auto-expire', retryCount: 0,
      finishedAt, errorSummary: error.message,
    }, new Date(finishedAt.getTime() + 60_000))).toEqual({ retryCount: 1, supersedeJobId: null });
  });
});
