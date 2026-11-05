import { AdminApiError } from './admin-api';
import { readCloudWorkspaceSelection } from './cloud-workspace-selection';
import type { InstancePowerTarget } from './admin-types';

export type ExpiryOperation = { idempotencyKey: string; confirmationId?: string };
export type ExpiryView = {
  instances: Array<{ id: string; name: string; status: string; expiresAt: string | null }>;
  jobs: Array<{ id: string; instanceId: string; status: string; previousExpiresAt: string | null; requestedExpiresAt: string;
    createdAt: string; error: string | null }>;
  warnings: string[];
};
export type ExpiryPreview = {
  target: InstancePowerTarget; expiresAt: string; planDigest: string; warnings: string[];
  plans: Array<{ instanceId: string; instanceName: string; expiresAt: string; requestedExpiresAt: string; cloudReleaseAt: string;
    hosts: Array<{ instanceId: string }> }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
};
const path = (base: string, target: InstancePowerTarget) => `${base}/admin/instance-expiry/${target.kind}/${encodeURIComponent(target.id)}`;
const headers = (token: string, operation?: ExpiryOperation) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  ...(readCloudWorkspaceSelection() ? { 'x-cloud-workspace-id': readCloudWorkspaceSelection()! } : {}),
  ...(operation ? { 'x-idempotency-key': operation.idempotencyKey, ...(operation.confirmationId ? { 'x-confirmation-id': operation.confirmationId } : {}) } : {}) });
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new AdminApiError(response.status, typeof body?.message === 'string' ? body.message : '回收时间请求未完成，请查看原任务。', body);
  return body;
}
export async function fetchInstanceExpiry(base: string, token: string, target: InstancePowerTarget) {
  return read<ExpiryView>(await fetch(path(base, target), { headers: headers(token) }));
}
export async function previewInstanceExpiry(base: string, token: string, target: InstancePowerTarget, expiresAt: string) {
  return read<ExpiryPreview>(await fetch(`${path(base, target)}/preview?${new URLSearchParams({ expiresAt })}`,
    { headers: headers(token), signal: AbortSignal.timeout(180_000) }));
}
export async function submitInstanceExpiry(base: string, token: string, preview: ExpiryPreview, operation: ExpiryOperation, signal?: AbortSignal) {
  const workspace = readCloudWorkspaceSelection();
  const body = JSON.stringify({ expiresAt: preview.expiresAt, planDigest: preview.planDigest });
  const send = () => {
    signal?.throwIfAborted();
    if (workspace !== readCloudWorkspaceSelection()) throw new Error('账号空间已切换，未继续修改回收时间。');
    return fetch(path(base, preview.target), { method: 'POST', headers: headers(token, operation), body, signal }).then(read<Record<string, unknown>>);
  };
  try { return await send(); }
  catch (error) {
    if (!(error instanceof AdminApiError) || error.status !== 409 || operation.confirmationId) throw error;
    const envelope = error.details as { code?: string; confirmationId?: string; idempotencyKey?: string; summary?: {
      target?: InstancePowerTarget; expiresAt?: string; planDigest?: string; instances?: Array<{ id: string; previousExpiresAt: string }> } };
    if (envelope?.code !== 'CONFIRMATION_REQUIRED') throw error;
    if (!envelope.confirmationId || envelope.idempotencyKey !== operation.idempotencyKey
      || envelope.summary?.planDigest !== preview.planDigest || envelope.summary.expiresAt !== preview.expiresAt
      || envelope.summary.target?.kind !== preview.target.kind || envelope.summary.target?.id !== preview.target.id
      || JSON.stringify(envelope.summary.instances?.map(item => [item.id, item.previousExpiresAt])) !== JSON.stringify(preview.plans.map(item => [item.instanceId, item.expiresAt])))
      throw new Error('服务端确认的实例或回收时间与预览不符，未执行修改。');
    operation.confirmationId = envelope.confirmationId;
    return send();
  }
}
export async function verifyInstanceExpiry(base: string, token: string, target: InstancePowerTarget, jobId: string) {
  return read(await fetch(`${path(base, target)}/jobs/${encodeURIComponent(jobId)}/verify`, { method: 'POST', headers: headers(token), body: '{}' }));
}
