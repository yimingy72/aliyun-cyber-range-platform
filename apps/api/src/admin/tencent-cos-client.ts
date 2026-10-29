import { createHash, createHmac } from 'node:crypto';

export type CosContextCredentials = { id?: string; provider: string; accountUid: string | null; regionId: string;
  accessKeyId: string; accessKeySecret: string; appId?: string; securityToken?: string };
export type CosObjectInput = { contextCredentials: CosContextCredentials; bucketName: string; objectKey: string; headers?: Record<string, string> };
export type CosPresignInput = CosObjectInput & { method: 'PUT' | 'GET'; expiresAt: Date };
export type CosObjectRequestInput = CosObjectInput & { method: 'HEAD' | 'DELETE' };
export class TencentCosRequestError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(`腾讯云 COS 请求未完成（${code}）。`); }
}
export const COS_SINGLE_PUT_MAX_BYTES = 5 * 1024 ** 3;
export const COS_MAX_SIGNATURE_TTL_SECONDS = 86400;
function fail(): never { throw new TencentCosRequestError('INVALID_REQUEST'); }
export const cosEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function assertCosContext(context: CosContextCredentials, bucketName?: string) {
  if (context.provider !== 'tencent_cloud' || !context.accountUid || !/^\d+$/.test(context.accountUid)
    || !/^(?:ap|na|eu|sa|me|af)-[a-z0-9-]+$/.test(context.regionId)
    || !context.accessKeyId || /[\s\r\n]/.test(context.accessKeyId) || !context.accessKeySecret
    || context.securityToken && /[\r\n]/.test(context.securityToken)) fail();
  if (bucketName) {
    const match = /^([a-z0-9][a-z0-9-]{1,48}[a-z0-9])-([1-9]\d{0,15})$/.exec(bucketName);
    if (!match || bucketName.length > 63 || !Number.isSafeInteger(Number(match[2])) || !context.appId || match[2] !== context.appId) fail();
  }
}
function headersOf(input: Record<string, string>) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(key) || typeof value !== 'string' || /[\r\n\x00-\x1f\x7f]/.test(value) || key in headers
      || ['authorization', 'connection', 'transfer-encoding'].includes(key)) fail();
    headers[key] = value.trim();
  }
  return headers;
}
function canonical(values: Record<string, string>) {
  const entries = Object.entries(values).map(([key, value]) => [cosEncode(key).toLowerCase(), cosEncode(value)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) fail();
  return { list: entries.map(([key]) => key).join(';'), text: entries.map(([key, value]) => `${key}=${value}`).join('&') };
}
// COS signs the decoded URI path; headers/query values are RFC3986-encoded exactly once.
// https://cloud.tencent.com/document/product/436/7778
export function signCosRequest(input: { contextCredentials: CosContextCredentials; method: string; host: string; path: string;
  headers?: Record<string, string>; query?: Record<string, string>; startsAt?: Date; expiresAt: Date }) {
  assertCosContext(input.contextCredentials);
  const start = Math.floor((input.startsAt?.getTime() ?? Date.now()) / 1000);
  const end = Math.floor(input.expiresAt.getTime() / 1000);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > COS_MAX_SIGNATURE_TTL_SECONDS
    || !['GET', 'HEAD', 'PUT', 'DELETE'].includes(input.method) || !input.path.startsWith('/')
    || /[\r\n\x00]/.test(input.path) || !/^[a-z0-9.-]+\.myqcloud\.com$/.test(input.host)) fail();
  if (input.host !== 'service.cos.myqcloud.com') {
    const suffix = `.cos.${input.contextCredentials.regionId}.myqcloud.com`;
    if (!input.host.endsWith(suffix)) fail();
    assertCosContext(input.contextCredentials, input.host.slice(0, -suffix.length));
  }
  const headers = headersOf(input.headers ?? {});
  if (headers.host && headers.host !== input.host) fail();
  headers.host = input.host;
  if (input.contextCredentials.securityToken && !input.query?.['x-cos-security-token']) headers['x-cos-security-token'] = input.contextCredentials.securityToken;
  if (input.query?.['x-cos-security-token'] && input.query['x-cos-security-token'] !== input.contextCredentials.securityToken) fail();
  const head = canonical(headers), query = canonical(input.query ?? {});
  const keyTime = `${start};${end}`;
  const key = createHmac('sha1', input.contextCredentials.accessKeySecret).update(keyTime).digest('hex');
  const http = `${input.method.toLowerCase()}\n${input.path}\n${query.text}\n${head.text}\n`;
  const toSign = `sha1\n${keyTime}\n${createHash('sha1').update(http).digest('hex')}\n`;
  const signature = createHmac('sha1', key).update(toSign).digest('hex');
  const authorization = `q-sign-algorithm=sha1&q-ak=${input.contextCredentials.accessKeyId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${head.list}&q-url-param-list=${query.list}&q-signature=${signature}`;
  return { authorization, headers };
}
function objectPath(key: string) {
  if (!key || Buffer.byteLength(key, 'utf8') > 1024 || key.startsWith('/') || /[\x00-\x1f\x7f]/.test(key)
    || key.split('/').some(part => !part || part === '.' || part === '..')) fail();
  return { raw: `/${key}`, encoded: `/${key.split('/').map(cosEncode).join('/')}` };
}
export function presignCosObject(input: CosPresignInput) {
  const context = Object.freeze({ ...input.contextCredentials });
  assertCosContext(context, input.bucketName);
  const host = `${input.bucketName}.cos.${context.regionId}.myqcloud.com`;
  const path = objectPath(input.objectKey), headers = headersOf(input.headers ?? {});
  if (input.method === 'PUT') {
    const size = Number(headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0 || size > COS_SINGLE_PUT_MAX_BYTES || !headers['content-type']
      || headers['x-cos-forbid-overwrite'] !== 'true' || !headers['x-cos-meta-platform-image-job'] || !headers['x-cos-meta-platform-image-owner']
      || !context.id || headers['x-cos-meta-platform-cloud-context'] !== context.id) fail();
  }
  const signed = signCosRequest({ contextCredentials: context, method: input.method, host, path: path.raw, headers, expiresAt: input.expiresAt,
    ...(context.securityToken ? { query: { 'x-cos-security-token': context.securityToken } } : {}) });
  const query = new URLSearchParams(signed.authorization);
  if (context.securityToken) query.set('x-cos-security-token', context.securityToken);
  // The browser generates Content-Length for the File body; it remains signed but is not an unsafe response header to set.
  const publicHeaders = Object.fromEntries(Object.entries(signed.headers).filter(([key]) => !['host', 'content-length', 'x-cos-security-token'].includes(key)));
  return { url: `https://${host}${path.encoded}?${query.toString()}`, headers: publicHeaders };
}
export async function requestCos(input: { contextCredentials: CosContextCredentials; bucketName?: string; method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  path?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }) {
  const context = Object.freeze({ ...input.contextCredentials });
  assertCosContext(context, input.bucketName);
  const host = input.bucketName ? `${input.bucketName}.cos.${context.regionId}.myqcloud.com` : 'service.cos.myqcloud.com';
  const path = input.path ?? '/';
  if (input.body !== undefined && input.method !== 'PUT') fail();
  const query = Object.entries(input.query ?? {}).map(([key, value]) => `${cosEncode(key)}=${cosEncode(value)}`).join('&');
  const headers = headersOf(input.headers ?? {});
  headers.date = new Date().toUTCString();
  if (input.body !== undefined) { headers['content-length'] = String(Buffer.byteLength(input.body)); headers['content-md5'] = createHash('md5').update(input.body).digest('base64'); }
  const signed = signCosRequest({ contextCredentials: context, method: input.method, host, path, query: input.query, headers, expiresAt: new Date(Date.now() + 5 * 60_000) });
  let response: Response;
  try {
    response = await fetch(`https://${host}${path.split('/').map(cosEncode).join('/')}${query ? `?${query}` : ''}`, {
      method: input.method, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { ...signed.headers, Authorization: signed.authorization },
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
  } catch { throw new TencentCosRequestError('NETWORK_OR_TIMEOUT'); }
  if (!response.headers.get('x-cos-request-id') || !/^[A-Za-z0-9+/=_-]{1,200}$/.test(response.headers.get('x-cos-request-id')!)) {
    throw new TencentCosRequestError('INVALID_RESPONSE', response.status);
  }
  if (!response.ok && (response.status !== 404 || !['GET', 'HEAD', 'DELETE'].includes(input.method))) throw new TencentCosRequestError(`HTTP_${response.status}`, response.status);
  return response;
}
export function requestCosObject(input: CosObjectRequestInput) {
  if (!['HEAD', 'DELETE'].includes(input.method)) fail();
  const path = objectPath(input.objectKey);
  return requestCos({ ...input, path: path.raw });
}
