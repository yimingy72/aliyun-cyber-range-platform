'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { AdminApiError, fetchRangeTemplates, launchRangeInstance } from '@/lib/admin-api';
import type { RangeInstanceLaunchInput } from '@/lib/admin-types';
import { cloudExpiryError } from '@/lib/cloud-execution-policy';
import { useAdminScreenCache } from '@/lib/admin-screen-cache';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import { Button } from '@/components/ui/button';
import { parseLocalDate } from '@/components/ui/date-time-picker';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { useAdminSession } from './use-admin-session';
import { useAdminRouteIsActive } from './admin-page-cache';
import { RangeInstanceCreateDialog } from './shared/range-instance-create-dialog';

export function RangeInstanceCreateButton({ apiBaseUrl }: { apiBaseUrl: string }) {
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
  const [draft, setDraft] = useState({ templateId: '', name: '', expiresAt: '' });
  const scope = JSON.stringify([apiBaseUrl, session.profile?.id, workspace?.id]);
  const current = useRef({ scope, token: session.token, active });
  current.current = { scope, token: session.token, active };
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const request = useRef<{ fingerprint: string; key: string; payload: RangeInstanceLaunchInput } | null>(null);
  const fingerprint = JSON.stringify([scope, draft.templateId, draft.name.trim(), draft.expiresAt.trim()]);
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
      const date = parseLocalDate(draft.expiresAt);
      if (!date) { setError('请选择有效的到期时间。'); return; }
      const expiryError = cloudExpiryError(draft.expiresAt, workspace?.provider ?? 'alibaba_cloud');
      if (expiryError) { setError(expiryError); return; }
      request.current = { fingerprint, key: crypto.randomUUID(), payload: { templateId: draft.templateId, name, expiresAt: date.toISOString() } };
    }
    const original = request.current!;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await launchRangeInstance(apiBaseUrl, session.token, original.payload, original.key);
      if (!mounted.current || current.current.scope !== scope) return;
      request.current = null;
      cache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      setOpen(false);
      if (current.current.active) router.push(`/admin/ranges/${result.id}`);
    } catch (failure) {
      if (!mounted.current || current.current.scope !== scope) return;
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
    <Button disabled={!canCreate} type="button" onClick={() => { request.current = null; setDraft({ templateId: '', name: '', expiresAt: '' }); setError(null); setOpen(true); }}><Plus aria-hidden="true" />创建实例</Button>
    <RangeInstanceCreateDialog open={open && active} pending={pending} canCreate={canCreate} canReplay={canReplay} onOpenChange={setOpen} onConfirm={() => void create()} name={draft.name} expiresAt={draft.expiresAt} onNameChange={(name) => setDraft((value) => ({ ...value, name }))} onExpiryChange={(expiresAt) => setDraft((value) => ({ ...value, expiresAt }))} templateId={draft.templateId} templateOptions={options} loadingTemplates={loading} templateError={templateError} onRetryTemplates={() => setAttempt((value) => value + 1)} onTemplateChange={(templateId) => setDraft((value) => ({ ...value, templateId }))} error={error} tencentCloud={workspace?.provider === 'tencent_cloud'} />
  </>;
}
