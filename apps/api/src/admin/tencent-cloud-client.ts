import { createHash, createHmac } from 'node:crypto';

export type TencentCloudRequest = {
  service: string;
  version: string;
  action: string;
  regionId?: string;
  accessKeyId: string;
  accessKeySecret: string;
  parameters?: Record<string, unknown>;
};

export class TencentCloudRequestError extends Error {
  readonly service?: string;
  readonly action?: string;
  constructor(readonly code: string, readonly requestId?: string, metadata?: { service?: string; action?: string }) {
    const service = metadata?.service && /^[a-z][a-z0-9]{1,31}$/.test(metadata.service) ? metadata.service : undefined;
    const action = metadata?.action && /^[A-Z][A-Za-z0-9]{1,99}$/.test(metadata.action) ? metadata.action : undefined;
    super(`腾讯云请求失败（${code}${service && action ? `；service=${service}；action=${action}` : ''}）。`);
    this.name = 'TencentCloudRequestError';
    this.service = service;
    this.action = action;
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export async function requestTencentCloud<T>(input: TencentCloudRequest): Promise<T> {
  if (!/^[a-z][a-z0-9]{1,31}$/.test(input.service)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.version)
    || !/^[A-Z][A-Za-z0-9]{1,99}$/.test(input.action)
    || (input.regionId !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(input.regionId))
    || !input.accessKeyId || !input.accessKeySecret || /[\r\n]/.test(input.accessKeyId)) {
    throw new TencentCloudRequestError('INVALID_REQUEST');
  }

  const requestMetadata = {
    service: !input.service.includes(input.accessKeyId) && !input.service.includes(input.accessKeySecret) ? input.service : undefined,
    action: !input.action.includes(input.accessKeyId) && !input.action.includes(input.accessKeySecret) ? input.action : undefined,
  };

  const host = `${input.service}.tencentcloudapi.com`;
  const contentType = 'application/json; charset=utf-8';
  const body = JSON.stringify(input.parameters ?? {});
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${input.action.toLowerCase()}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = createHmac('sha256', `TC3${input.accessKeySecret}`).update(date).digest();
  const secretService = createHmac('sha256', secretDate).update(input.service).digest();
  const secretSigning = createHmac('sha256', secretService).update('tc3_request').digest();
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(`https://${host}/`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `TC3-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'Content-Type': contentType,
        Host: host,
        'X-TC-Action': input.action,
        'X-TC-Version': input.version,
        'X-TC-Timestamp': String(timestamp),
        ...(input.regionId ? { 'X-TC-Region': input.regionId } : {}),
      },
      body,
    });
    try { payload = await response.json(); } catch { payload = null; }
  } catch {
    // A failed request can have reached the cloud; callers must reconcile before retrying writes.
    throw new TencentCloudRequestError('NETWORK_OR_TIMEOUT', undefined, requestMetadata);
  }

  const result = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { Response?: unknown }).Response : null;
  if (result && typeof result === 'object' && !Array.isArray(result) && 'Error' in result) {
    const error = (result as { Error?: unknown }).Error;
    const rawCode = error && typeof error === 'object' ? (error as { Code?: unknown }).Code : null;
    const code = typeof rawCode === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(rawCode)
      && !rawCode.includes(input.accessKeyId) && !rawCode.includes(input.accessKeySecret) ? rawCode : 'CLOUD_ERROR';
    const rawRequestId = (result as { RequestId?: unknown }).RequestId;
    const requestId = typeof rawRequestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(rawRequestId)
      && !rawRequestId.includes(input.accessKeyId) && !rawRequestId.includes(input.accessKeySecret) ? rawRequestId : undefined;
    throw new TencentCloudRequestError(code, requestId, requestMetadata);
  }
  if (!response.ok) throw new TencentCloudRequestError(`HTTP_${response.status}`, undefined, requestMetadata);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof (result as { RequestId?: unknown }).RequestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test((result as { RequestId: string }).RequestId)) {
    throw new TencentCloudRequestError('INVALID_RESPONSE', undefined, requestMetadata);
  }
  return result as T;
}
