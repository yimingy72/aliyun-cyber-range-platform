import { AdminApiError } from './admin-api';
import { readCloudWorkspaceSelection } from './cloud-workspace-selection';
import type { InstancePowerAction, InstancePowerPreview, InstancePowerTarget, InstancePowerView } from './admin-types';

export type PowerOperation = { idempotencyKey: string; confirmationId?: string };
const path = (base: string, target: InstancePowerTarget) => `${base}/admin/instance-power/${target.kind}/${encodeURIComponent(target.id)}`;
const headers = (token: string, operation?: PowerOperation) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  ...(readCloudWorkspaceSelection() ? { 'x-cloud-workspace-id': readCloudWorkspaceSelection()! } : {}),
  ...(operation ? { 'x-idempotency-key': operation.idempotencyKey, ...(operation.confirmationId ? { 'x-confirmation-id': operation.confirmationId } : {}) } : {}) });

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new AdminApiError(response.status, typeof body?.message === 'string' ? body.message : '电源任务请求未完成，请核对原任务。', body);
  return body;
}
export async function fetchInstancePower(base: string, token: string, target: InstancePowerTarget) {
  return read<InstancePowerView>(await fetch(path(base, target), { headers: headers(token) }));
}
export async function previewInstancePower(base: string, token: string, target: InstancePowerTarget, action: InstancePowerAction, scheduledAt?: string) {
  const query = new URLSearchParams({ action, ...(scheduledAt ? { scheduledAt } : {}) });
  return read<InstancePowerPreview>(await fetch(`${path(base, target)}/preview?${query}`, { headers: headers(token), signal: AbortSignal.timeout(180_000) }));
}
export async function submitInstancePower(base: string, token: string, preview: InstancePowerPreview, operation: PowerOperation) {
  const workspace = readCloudWorkspaceSelection();
  const body = JSON.stringify({ action: preview.action, planDigest: preview.planDigest, ...(preview.scheduledAt ? { scheduledAt: preview.scheduledAt } : {}) });
  const send = () => {
    if (readCloudWorkspaceSelection() !== workspace) throw new Error('账号空间已切换，未继续提交电源操作。');
    return fetch(path(base, preview.target), { method: 'POST', headers: headers(token, operation), body }).then(read<Record<string, unknown>>);
  };
  let result;
  try { result = await send(); }
  catch (error) {
    if (!(error instanceof AdminApiError) || error.status !== 409 || operation.confirmationId) throw error;
    const envelope = error.details as { code?: string; confirmationId?: string; idempotencyKey?: string; summary?: { action?: string; scheduledAt?: string | null; instances?: Array<{ id: string; hostCount: number }> } };
    if (envelope?.code !== 'CONFIRMATION_REQUIRED') throw error;
    if (!envelope.confirmationId || envelope.idempotencyKey !== operation.idempotencyKey || envelope.summary?.action !== preview.action
      || envelope.summary.scheduledAt !== preview.scheduledAt || JSON.stringify(envelope.summary.instances?.map(row => [row.id, row.hostCount])) !== JSON.stringify(preview.plans.map(row => [row.instanceId, row.hosts.length])))
      throw new Error('服务端确认目标与当前电源预览不符，未执行。');
    operation.confirmationId = envelope.confirmationId;
    result = await send();
  }
  return 'result' in result && result.result && typeof result.result === 'object' ? result.result : result;
}
export async function cancelInstancePowerSchedule(base: string, token: string, target: InstancePowerTarget, schedules: Array<{ instanceId: string; scheduleId: string; revision: number }>, operation: PowerOperation) {
  return read(await fetch(`${path(base, target)}/cancel`, { method: 'POST', headers: headers(token, operation), body: JSON.stringify({ schedules }) }));
}
export async function verifyInstancePowerJob(base: string, token: string, target: InstancePowerTarget, jobId: string) {
  return read(await fetch(`${path(base, target)}/jobs/${encodeURIComponent(jobId)}/verify`, { method: 'POST', headers: headers(token), body: '{}' }));
}
