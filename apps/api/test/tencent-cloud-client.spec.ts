import { requestTencentCloud, TencentCloudRequestError } from '../src/admin/tencent-cloud-client';

const input = { service: 'cvm', version: '2017-03-12', action: 'DescribeZones', regionId: 'ap-shanghai', accessKeyId: 'synthetic-access-key', accessKeySecret: 'synthetic-access-secret', parameters: {} };
const json = (Response: unknown, status = 200) => new globalThis.Response(JSON.stringify({ Response }), { status });
describe('Tencent Cloud TC3 request boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it('signs the POST body and action at the fixed official endpoint with a bounded request', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 9, 0, 0, 0));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'request-1', ZoneSet: [] }));
    await expect(requestTencentCloud(input)).resolves.toEqual({ RequestId: 'request-1', ZoneSet: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://cvm.tencentcloudapi.com/', expect.objectContaining({
      method: 'POST', redirect: 'error', body: '{}', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        'Content-Type': 'application/json; charset=utf-8', Host: 'cvm.tencentcloudapi.com',
        'X-TC-Action': 'DescribeZones', 'X-TC-Version': '2017-03-12', 'X-TC-Region': 'ap-shanghai',
        'X-TC-Timestamp': '1791504000',
        Authorization: expect.stringMatching(/^TC3-HMAC-SHA256 Credential=synthetic-access-key\/2026-10-09\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[a-f0-9]{64}$/),
      }),
    }));
    expect(JSON.stringify(fetch.mock.calls[0])).not.toContain(input.accessKeySecret);
  });
  it('supports regionless identity requests and never copies cloud error messages into errors', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'request-2', Error: { Code: 'AuthFailure.SignatureFailure', Message: `private:${input.accessKeyId}/${input.accessKeySecret}` } }));
    try { await requestTencentCloud({ ...input, service: 'sts', action: 'GetCallerIdentity', regionId: undefined }); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(TencentCloudRequestError);
      expect((error as TencentCloudRequestError).code).toBe('AuthFailure.SignatureFailure');
      expect(String(error)).not.toContain(input.accessKeyId); expect(String(error)).not.toContain(input.accessKeySecret);
    }
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('X-TC-Region');
  });
  it.each([{ RequestId: '' }, { RequestId: 1 }, {}, [], null, { RequestId: 'invalid\nprivate' }])('rejects incomplete success responses %j', async (body) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json(body));
    await expect(requestTencentCloud(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('sanitizes malformed error codes and non-JSON HTTP failures', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Error: { Code: input.accessKeySecret, Message: 'private' } })).mockResolvedValueOnce(new Response('private', { status: 503 }));
    await expect(requestTencentCloud(input)).rejects.toMatchObject({ code: 'CLOUD_ERROR' });
    await expect(requestTencentCloud(input)).rejects.toMatchObject({ code: 'HTTP_503' });
  });
  it('does not retry write requests on an unknown network result', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(input.accessKeySecret));
    await expect(requestTencentCloud({ ...input, action: 'RunInstances' })).rejects.toMatchObject({ code: 'NETWORK_OR_TIMEOUT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ service: '../bad' }, { service: 'cvm.evil' }, { action: 'DescribeZones\r\n' }, { regionId: 'https://evil' }, { accessKeyId: 'bad\nkey' }])('rejects invalid transport input before fetch: %j', async (patch) => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(requestTencentCloud({ ...input, ...patch })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
