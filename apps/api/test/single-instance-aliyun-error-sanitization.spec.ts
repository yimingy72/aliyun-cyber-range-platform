import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import type { AdminRepository } from '../src/admin/admin.repository';
import type { SystemConfigService } from '../src/admin/system-config.service';

type RpcInput = {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  action: string;
  method?: 'GET' | 'POST';
  parameters?: Record<string, string>;
};

function createService() {
  return new SingleInstanceBatchExecutionService({} as unknown as AdminRepository, {} as unknown as SystemConfigService);
}

function callRpc(service: SingleInstanceBatchExecutionService, input?: Partial<RpcInput>) {
  const invoke = (service as unknown as { performAliyunRpcRequest: (value: RpcInput) => Promise<unknown> })
    .performAliyunRpcRequest.bind(service);
  return invoke({ accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', regionId: 'cn-test',
    action: 'RunInstances', method: 'POST', parameters: {}, ...input });
}

describe('single-instance Aliyun error surfacing', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps only the machine-readable code and status for HTTP error bodies', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      RequestId: 'request-1',
      HostId: 'ecs.cn-test.aliyuncs.com',
      Code: 'InvalidParameter.Password',
      Message: 'The password should contain private-value-123',
    }), { status: 400 })) as unknown as typeof fetch;

    const failure = (await callRpc(createService()).catch((value: unknown) => value)) as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Aliyun RunInstances request failed with status 400 (InvalidParameter.Password)');
    expect(failure.message).not.toContain('private-value-123');
  });

  it('retains destroy classification codes used by verification and retries', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      Code: 'IncorrectInstanceStatus.Initializing',
      Message: 'The operation is not allowed while preparing',
    }), { status: 400 })) as unknown as typeof fetch;
    const retryable = (await callRpc(createService(), { action: 'TerminateInstance' }).catch((value: unknown) => value)) as Error;
    expect(retryable.message).toBe('Aliyun TerminateInstance request failed with status 400 (IncorrectInstanceStatus.Initializing)');

    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      Code: 'InvalidInstanceId.NotFound',
    }), { status: 404 })) as unknown as typeof fetch;
    const gone = (await callRpc(createService(), { action: 'TerminateInstance' }).catch((value: unknown) => value)) as Error;
    expect(gone.message).toBe('Aliyun TerminateInstance request failed with status 404 (InvalidInstanceId.NotFound)');
  });

  it('keeps only the status when the body is HTML, empty, or carries an invalid code', async () => {
    for (const body of ['<html><body>gateway failure</body></html>', '', JSON.stringify({ Code: 'bad code with spaces', Message: 'raw' }),
      JSON.stringify({ Code: { nested: 'raw-code' } })]) {
      global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 502 })) as unknown as typeof fetch;
      const failure = (await callRpc(createService()).catch((value: unknown) => value)) as Error;
      expect(failure.message).toBe('Aliyun RunInstances request failed with status 502');
    }
  });

  it('never echoes non-JSON success bodies through parse errors', async () => {
    for (const body of ['private-value-123', '', 'null', '[]', '123']) {
      global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof fetch;
      const failure = (await callRpc(createService()).catch((value: unknown) => value)) as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe('Aliyun RunInstances returned an invalid response');
      expect(failure.message).not.toContain('private-value-123');
      expect(failure.message).not.toContain('Unexpected token');
    }
  });

  it('sanitizes the HTTP 200 rejection branch with the same code rules', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      Code: 'InvalidParameter.Password',
      Message: 'raw message with private-value-456',
    }), { status: 200 })) as unknown as typeof fetch;
    const failure = (await callRpc(createService()).catch((value: unknown) => value)) as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Aliyun RunInstances rejected: InvalidParameter.Password');
    expect(failure.message).not.toContain('private-value-456');

    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      Code: 'not a valid code !',
      Message: 'raw message',
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(callRpc(createService())).rejects.toThrow('Aliyun RunInstances rejected: UNCLASSIFIED');
  });

  it('returns successful payloads untouched', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      InstanceIdSets: { InstanceIdSet: ['i-synthetic'] },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(callRpc(createService())).resolves.toEqual({ InstanceIdSets: { InstanceIdSet: ['i-synthetic'] } });
  });
});
