import { createHash, createHmac } from 'node:crypto';
import { COS_SINGLE_PUT_MAX_BYTES, presignCosObject, requestCos, requestCosObject, signCosRequest } from '../src/admin/tencent-cos-client';
import { parseCosXml, xmlText } from '../src/admin/tencent-cos-xml';
const context = { id: 'fixture-context', provider: 'tencent_cloud', accountUid: '100001', appId: '1250000000', regionId: 'ap-shanghai', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' };
const bucket = 'fixture-bucket-1250000000';
const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': '5', 'x-cos-forbid-overwrite': 'true',
  'x-cos-meta-platform-image-job': 'job-1', 'x-cos-meta-platform-image-owner': 'owner-1', 'x-cos-meta-platform-cloud-context': context.id };

describe('COS XML signing and bounded object transport', () => {
  it('matches the official canonical SHA1/HMAC derivation including empty query values and UTF8 paths', () => {
    const start = new Date('2026-10-10T00:00:00Z'), end = new Date(start.getTime() + 60000);
    const keyTime = `${start.getTime() / 1000};${end.getTime() / 1000}`;
    const host = `${bucket}.cos.ap-shanghai.myqcloud.com`;
    const canonical = `get\n/目录(1)\nacl=&prefix=a%20b%2B%2F\nhost=${host}\n`;
    const key = createHmac('sha1', 'fixture-secret').update(keyTime).digest('hex');
    const signature = createHmac('sha1', key).update(`sha1\n${keyTime}\n${createHash('sha1').update(canonical).digest('hex')}\n`).digest('hex');
    const signed = signCosRequest({ contextCredentials: context, method: 'GET', host, path: '/目录(1)', query: { prefix: 'a b+/', acl: '' }, startsAt: start, expiresAt: end });
    expect(signed.authorization).toContain(`q-url-param-list=acl;prefix&q-signature=${signature}`);
  });
  it('binds upload size/owner/job/context and overwrite refusal while omitting browser-forbidden headers', () => {
    const signed = presignCosObject({ contextCredentials: context, bucketName: bucket, objectKey: 'job-1/目录(1).qcow2', method: 'PUT', headers, expiresAt: new Date(Date.now() + 60000) });
    const url = new URL(signed.url);
    expect(url.pathname).toBe('/job-1/%E7%9B%AE%E5%BD%95%281%29.qcow2');
    expect(url.searchParams.get('q-header-list')).toContain('content-length');
    expect(signed.headers).not.toHaveProperty('content-length');
    expect(signed.headers).not.toHaveProperty('host');
    expect(signed.headers['x-cos-meta-platform-cloud-context']).toBe('fixture-context');
    const temporary = presignCosObject({ contextCredentials: { ...context, securityToken: 'fixture-token+/=' }, bucketName: bucket, objectKey: 'file', method: 'GET', expiresAt: new Date(Date.now() + 60000) });
    expect(new URL(temporary.url).searchParams.get('x-cos-security-token')).toBe('fixture-token+/=');
    expect(new URL(temporary.url).searchParams.get('q-url-param-list')).toBe('x-cos-security-token');
    expect(new URL(temporary.url).searchParams.get('q-header-list')).not.toContain('x-cos-security-token');
  });
  it.each([{ provider: 'alibaba_cloud' }, { appId: '9999' }, { appId: undefined }, { accountUid: null }, { regionId: 'evil.invalid' }])('rejects wrong or unknown context %j', change => {
    expect(() => presignCosObject({ contextCredentials: { ...context, ...change }, bucketName: bucket, objectKey: 'file', method: 'GET', expiresAt: new Date(Date.now() + 60000) })).toThrow('INVALID_REQUEST');
  });
  it.each(['../file', 'dir/../file', '/file', 'dir//file', 'file\n', ''])('rejects unsafe object path %j', objectKey => {
    expect(() => presignCosObject({ contextCredentials: context, bucketName: bucket, objectKey, method: 'GET', expiresAt: new Date(Date.now() + 60000) })).toThrow('INVALID_REQUEST');
  });
  it.each([{ 'Content-Length': String(COS_SINGLE_PUT_MAX_BYTES + 1) }, { 'Content-Length': '0' }, { 'x-cos-forbid-overwrite': 'false' }, { 'x-cos-meta-platform-cloud-context': 'foreign' }])('rejects unsafe PUT constraint %j', change => {
    expect(() => presignCosObject({ contextCredentials: context, bucketName: bucket, objectKey: 'file', method: 'PUT', headers: { ...headers, ...change }, expiresAt: new Date(Date.now() + 60000) })).toThrow('INVALID_REQUEST');
  });
  it('never follows redirects or leaks URL/headers in transport failures', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('secret-bearing fake request failure'));
    await expect(requestCosObject({ contextCredentials: context, bucketName: bucket, objectKey: 'file', method: 'HEAD' })).rejects.toThrow('NETWORK_OR_TIMEOUT');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.anything() });
    fetch.mockRestore();
  });
  it('parses only complete bounded XML and rejects DTD, entity expansion, duplicate scalars and truncated documents', () => {
    expect(xmlText(parseCosXml('<?xml version="1.0"?><Owner><ID>a&amp;b</ID></Owner>', 'Owner'), 'ID')).toBe('a&b');
    for (const xml of ['<!DOCTYPE Owner><Owner/>', '<Owner><ID>&external;</ID></Owner>', '<Owner><ID>a</Owner>', '<Owner/>junk', '<Other/>']) expect(() => parseCosXml(xml, 'Owner')).toThrow();
    expect(() => xmlText(parseCosXml('<Owner><ID>a</ID><ID>b</ID></Owner>', 'Owner'), 'ID')).toThrow();
  });
  it('rejects a failed PUT while retaining explicit 404 evidence for HEAD and idempotent DELETE', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status:404,headers:{'x-cos-request-id':'fixture-not-found'} }));
    await expect(requestCos({contextCredentials:context,bucketName:bucket,method:'PUT',query:{cors:''},body:'fixture'})).rejects.toThrow('HTTP_404');
    await expect(requestCos({contextCredentials:context,bucketName:bucket,method:'HEAD'})).resolves.toMatchObject({status:404});
    await expect(requestCos({contextCredentials:context,bucketName:bucket,method:'DELETE'})).resolves.toMatchObject({status:404});
    fetch.mockRestore();
  });

});
