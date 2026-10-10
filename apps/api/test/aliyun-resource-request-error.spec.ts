import { AliyunEcsResourceClient, AliyunResourceRequestError } from '../src/provisioning/platform-resource-reconciliation.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

afterEach(() => jest.restoreAllMocks());
it('keeps a 404 cloud error distinct from an empty resource result and logs only safe fields', async () => {
  const secret = 'fixture-private-credential';
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ Code: 'InvalidAccessKeyId.NotFound', Message: secret, HostId: `https://example.test/${secret}` }), { status: 404 }));
  const client = new AliyunEcsResourceClient({} as any);
  let error!: AliyunResourceRequestError;
  try { await client.listPlatformManagedInstances({ accessKeyId: 'fixture-ak', accessKeySecret: secret, regionId: 'cn-beijing' }); }
  catch (caught) { error = caught as AliyunResourceRequestError; }
  expect(error).toBeInstanceOf(AliyunResourceRequestError);
  const logger = { error: jest.fn() };
  (ProvisioningWorkerService.prototype as any).logReconciliationFailure.call({ logger }, { id: 'space', provider: 'alibaba_cloud' }, 'context', error);
  const value = logger.error.mock.calls[0][0];
  expect(JSON.parse(value).error).toEqual({ code: 'InvalidAccessKeyId.NotFound', service: 'ecs', action: 'DescribeInstances', httpStatus: 404, regionId: 'cn-beijing' });
  expect(value).not.toContain(secret); expect(value).not.toContain('https://');
});
it('does not expose an unrecognized vendor error code or response message', () => {
  const error = new AliyunResourceRequestError('DescribeInstances', 403, 'cn-beijing', { Code: 'fixture-private-credential', Message: 'fixture-private-credential' });
  expect(error.code).toBe('ALIYUN_HTTP_403');
  expect(JSON.stringify(error)).not.toContain('fixture-private-credential');
});
