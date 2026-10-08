import { randomUUID } from 'node:crypto';
import { BadGatewayException } from '@nestjs/common';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';

export type ImageCredentials = { accessKeyId: string; accessKeySecret: string; regionId: string };
export async function imageRpc<T>(credentials: ImageCredentials, action: string, parameters: Record<string, string> = {}): Promise<T> {
  const query = signAliyunRpcQuery({ Action: action, AccessKeyId: credentials.accessKeyId, Format: 'JSON', RegionId: credentials.regionId,
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2014-05-26', ...parameters }, credentials.accessKeySecret);
  let response: Response;
  try { response = await fetch(`https://ecs.${credentials.regionId}.aliyuncs.com/?${query}`, { method: 'GET', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new BadGatewayException(`Aliyun ${action} unavailable`); }
  let body: Record<string, unknown>;
  try { body = await response.json() as Record<string, unknown>; } catch { throw new BadGatewayException(`Aliyun ${action} returned invalid JSON`); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !response.ok || (body.Success !== undefined && body.Success !== true) || (body.Code !== undefined && body.Code !== 'Success')) {
    throw new BadGatewayException(`Aliyun ${action} failed: ${typeof body?.Code === 'string' ? body.Code : response.status}`);
  }
  return body as T;
}

export function cloudItems<T>(body: unknown, container: string, item: string): T[] {
  if (!body || typeof body !== 'object') throw new BadGatewayException('Invalid image query response');
  const payload = body as Record<string, unknown>;
  const nested = payload[container];
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested))) throw new BadGatewayException('Invalid cloud query container');
  const values = nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[item] : undefined;
  if (values === undefined && (payload.TotalCount === 0 || payload.TotalCount === '0')) return [];
  const items = Array.isArray(values) ? values : values && typeof values === 'object' ? [values] : null;
  if (!items || items.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new BadGatewayException('Invalid image query item list');
  return items as T[];
}

export function cloudTotal(body: unknown): number {
  const raw = (body as { TotalCount?: unknown })?.TotalCount;
  if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0) throw new BadGatewayException('Invalid cloud query total count');
  return Number(raw);
}

export function cloudPage(body: unknown, page: number, size: number, itemCount: number): number {
  const payload = body as { PageNumber?: unknown; PageSize?: unknown };
  if ((payload.PageNumber !== undefined && cloudTotal({ TotalCount: payload.PageNumber }) !== page) || (payload.PageSize !== undefined && cloudTotal({ TotalCount: payload.PageSize }) !== size) || itemCount > size) throw new BadGatewayException('Invalid cloud query pagination');
  return cloudTotal(body);
}

export function cloudTags(value: unknown): Record<string, string> {
  const entries = value && typeof value === 'object' ? (value as { Tag?: unknown }).Tag : undefined;
  const items = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : [];
  return Object.fromEntries(items.flatMap(item => {
    const key = item.TagKey ?? item.Key;
    const value = item.TagValue ?? item.Value;
    return typeof key === 'string' && typeof value === 'string' ? [[key, value]] : [];
  }));
}
