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
      expect((error as TencentCloudRequestError).requestId).toBe('request-2');
      expect((error as TencentCloudRequestError).service).toBe('sts'); expect((error as TencentCloudRequestError).action).toBe('GetCallerIdentity');
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
  it.each(['invalid\nprivate', input.accessKeyId, input.accessKeySecret, null])('does not retain an invalid or credential-bearing error request ID', async requestId => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: requestId, Error: { Code: 'ResourceNotFound', Message: input.accessKeySecret } }));
    await expect(requestTencentCloud(input)).rejects.toMatchObject({ code: 'ResourceNotFound', requestId: undefined });
  });
  it('does not retry write requests on an unknown network result', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(input.accessKeySecret));
    await expect(requestTencentCloud({ ...input, action: 'RunInstances' })).rejects.toMatchObject({ code: 'NETWORK_OR_TIMEOUT', service: 'cvm', action: 'RunInstances' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps only a fixed CreateImage parameter and hint, never the vendor message or values', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'create-request', Error: {
      Code: 'InvalidParameterValue', Message: 'Parameter ImageName length invalid: private-business-name' } }));
    try { await requestTencentCloud({ ...input, action: 'CreateImage' }); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'InvalidParameterValue', requestId: 'create-request', parameterName: 'ImageName', hint: 'invalid_length' });
      expect(JSON.stringify(error)).not.toContain('private-business-name');
      expect(error).not.toHaveProperty('vendorMessage');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([input.accessKeySecret, 'unrecognizedPrivateParameter=private-value', null, 1])('does not retain arbitrary or credential-bearing diagnostic strings', async value => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'create-request', Error: { Code: 'InvalidParameterValue', Message: value } }));
    try { await requestTencentCloud({ ...input, action: 'CreateImage' }); throw new Error('unexpected success'); }
    catch (error) { expect(error).not.toHaveProperty('parameterName', value); expect(JSON.stringify(error)).not.toContain('private-value'); }
  });
  it('does not classify arbitrary messages from other actions', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'request-1', Error: { Code: 'InvalidParameterValue', Message: 'ImageName type invalid' } }));
    await expect(requestTencentCloud(input)).rejects.toMatchObject({ parameterName: undefined, hint: undefined });
  });
  it('does not retain credential-bearing or malformed service/action diagnostics', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ RequestId: 'safe-request', Error: { Code: 'ResourceNotFound' } }));
    const error = await requestTencentCloud({ ...input, service: 'vpc', action: 'DescribeAddresses', accessKeyId: 'vpc', accessKeySecret: 'DescribeAddresses' }).catch(value => value);
    if (!(error instanceof TencentCloudRequestError)) throw new Error('Expected typed synthetic cloud failure');
    expect(error.service).toBeUndefined(); expect(error.action).toBeUndefined();
    expect(error.message).toBe('腾讯云请求失败（ResourceNotFound）。');
    const invalid = new TencentCloudRequestError('SYNTHETIC', undefined, { service: 'private-host\nkey', action: 'private-message' });
    expect(invalid.service).toBeUndefined(); expect(invalid.action).toBeUndefined();
  });
  it('keeps service/action/code in safe job summary messages without vendor body or parameters', async () => {
    jest.spyOn(globalThis,'fetch').mockResolvedValue(json({ RequestId: 'cloud-acl-request', Error: { Code: 'ResourceNotFound', Message: `vendor-private:${input.accessKeySecret}` } }));
    const error = await requestTencentCloud({ ...input, service: 'vpc', action: 'DescribeNetworkAcls', parameters: { Filters: [{ Name: 'vpc-id', Values: ['private-params-must-not-return'] }] } }).catch(value => value);
    if (!(error instanceof TencentCloudRequestError)) throw new Error('Expected typed synthetic cloud failure');
    expect(error.message).toBe('腾讯云请求失败（ResourceNotFound；service=vpc；action=DescribeNetworkAcls）。');
    expect(JSON.stringify({ errorSummary: error.message })).not.toMatch(/vendor-private|private-params-must-not-return|synthetic-access/);
  });
  it.each([undefined, { service: 'vpc' }, { action: 'DescribeNetworkAcls' }, { service: '../invalid', action: 'DescribeNetworkAcls' }, { service: 'vpc', action: 'raw\nprivate' }])('preserves the legacy message when request metadata is incomplete or invalid %#', metadata => {
    expect(new TencentCloudRequestError('ResourceNotFound', undefined, metadata).message).toBe('腾讯云请求失败（ResourceNotFound）。');
  });
  it.each([{ service: '../bad' }, { service: 'cvm.evil' }, { action: 'DescribeZones\r\n' }, { regionId: 'https://evil' }, { accessKeyId: 'bad\nkey' }])('rejects invalid transport input before fetch: %j', async (patch) => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(requestTencentCloud({ ...input, ...patch })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
