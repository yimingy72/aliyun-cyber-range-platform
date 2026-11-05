'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { AdminApiError, fetchRangeTemplates, launchRangeInstance } from '@/lib/admin-api';
import { clearRangeLaunchBatch, readRangeLaunchBatch, saveRangeLaunchBatch, submitRangeLaunchBatch, type RangeLaunchBatchRequest } from '@/lib/range-launch-batch';
import { cloudExpiryError } from '@/lib/cloud-execution-policy';
import { useAdminScreenCache } from '@/lib/admin-screen-cache';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import { Button } from '@/components/ui/button';
import { parseLocalDate } from '@/components/ui/date-time-picker';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { useAdminSession } from './use-admin-session';
import { useAdminRouteIsActive } from './admin-page-cache';
import { RangeInstanceCreateDialog } from './shared/range-instance-create-dialog';

export function RangeInstanceCreateButton({ apiBaseUrl, onCreated }: { apiBaseUrl: string; onCreated?: () => void }) {
  const session = useAdminSession();
  const workspace = useCloudWorkspace()?.workspace;
  const active = useAdminRouteIsActive('/admin/ranges');
  const router = useRouter();
  const cache = useAdminScreenCache();
  const canCreate = !workspace || (!workspace.isReadOnly && workspace.capabilities.provisioning);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ templateId: '', name: '', expiresAt: '', quantity: '1' });
  const [acceptedCount, setAcceptedCount] = useState(0);
  const scope = JSON.stringify([apiBaseUrl, session.profile?.id, workspace?.id]);
  const current = useRef({ scope, token: session.token, active });
  current.current = { scope, token: session.token, active };
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const request = useRef<RangeLaunchBatchRequest | null>(null);
  const fingerprint = JSON.stringify([scope, draft.templateId, draft.name.trim(), draft.expiresAt.trim(), draft.quantity]);
  const canReplay = request.current?.fingerprint === fingerprint;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => { setOpen(false); setPending(false); request.current = null; }, [scope]);

  useEffect(() => {
    if (!open || !session.token) return;
    let live = true;
    setLoading(true); setTemplateError(null); setOptions([]);
    Promise.all([fetchRangeTemplates(apiBaseUrl, session.token, 'mine'), fetchRangeTemplates(apiBaseUrl, session.token, 'platform')]).then((lists) => {
      if (live) setOptions([...new Map(lists.flat().map((template) => [template.id, { value: template.id, label: template.name?.trim() || template.slug }])).values()]);
    }).catch((failure) => { if (live) setTemplateError(isUnauthorizedAdminError(failure) ? '登录已失效，请重新登录。' : '模板读取失败，请重试。'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [apiBaseUrl, session.token, open, scope, attempt]);

  async function create() {
    if (!canCreate || !session.token || inFlight.current || loading || !draft.templateId) return;
    const name = draft.name.trim();
    if (!name) { setError('请填写实例名。'); return; }
    if (!canReplay) {
      const quantity = Number(draft.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) { setError('创建数量必须是 1–99 的整数。'); return; }
      const date = parseLocalDate(draft.expiresAt);
      if (!date) { setError('请选择有效的到期时间。'); return; }
      const expiryError = cloudExpiryError(draft.expiresAt, workspace?.provider ?? 'alibaba_cloud');
      if (expiryError) { setError(expiryError); return; }
      request.current = { fingerprint, key: crypto.randomUUID(), payload: { templateId: draft.templateId, name, expiresAt: date.toISOString() }, quantity, expiresAtInput: draft.expiresAt, accepted: [] };
    }
    const original = request.current!;
    inFlight.current = true; setPending(true); setError(null);
    try {
      saveRangeLaunchBatch(scope, original);
      const results = await submitRangeLaunchBatch(original,
        (payload, key) => launchRangeInstance(apiBaseUrl, session.token!, payload, key),
        () => mounted.current && current.current.scope === scope && current.current.active,
        (count) => { saveRangeLaunchBatch(scope, original); if (mounted.current && current.current.scope === scope) setAcceptedCount(count); });
      if (!mounted.current || current.current.scope !== scope) return;
      request.current = null;
      clearRangeLaunchBatch(scope, original.key);
      cache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      onCreated?.();
      setOpen(false);
      if (current.current.active) router.push(results.length === 1 ? `/admin/ranges/${results[0]!.id}` : '/admin/ranges');
    } catch (failure) {
      if (!mounted.current || current.current.scope !== scope) return;
      cache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      onCreated?.();
      if (isUnauthorizedAdminError(failure)) {
        if (current.current.token !== session.token) return;
        session.logout(); router.replace('/admin/login');
      } else setError(failure instanceof AdminApiError ? failure.message : '创建结果尚未确认，可重试当前提交查询原任务；请勿新建重复编排。');
    } finally {
      inFlight.current = false;
      if (mounted.current && current.current.scope === scope) setPending(false);
    }
  }

  return <>
    <Button disabled={!canCreate} type="button" onClick={() => { const original = readRangeLaunchBatch(scope); request.current = original; setDraft(original ? { templateId: original.payload.templateId, name: original.payload.name, expiresAt: original.expiresAtInput, quantity: String(original.quantity) } : { templateId: '', name: '', expiresAt: '', quantity: '1' }); setAcceptedCount(original?.accepted.length ?? 0); setError(original ? '创建结果尚未确认，请继续查询原请求；已受理的实例不会重复提交。' : null); setOpen(true); }}><Plus aria-hidden="true" />创建实例</Button>
    <RangeInstanceCreateDialog open={open && active} pending={pending} canCreate={canCreate} canReplay={canReplay} onOpenChange={setOpen} onConfirm={() => void create()} name={draft.name} expiresAt={draft.expiresAt} quantity={draft.quantity} acceptedCount={acceptedCount} onQuantityChange={(quantity) => setDraft((value) => ({ ...value, quantity }))} onNameChange={(name) => setDraft((value) => ({ ...value, name }))} onExpiryChange={(expiresAt) => setDraft((value) => ({ ...value, expiresAt }))} templateId={draft.templateId} templateOptions={options} loadingTemplates={loading} templateError={templateError} onRetryTemplates={() => setAttempt((value) => value + 1)} onTemplateChange={(templateId) => setDraft((value) => ({ ...value, templateId }))} error={error} tencentCloud={workspace?.provider === 'tencent_cloud'} />
  </>;
}
