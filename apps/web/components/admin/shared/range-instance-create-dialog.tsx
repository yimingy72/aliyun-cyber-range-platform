'use client';

import { AdminNotice } from './admin-notice';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Input } from '@/components/ui/input';
import { AdminDialog } from './admin-dialog';
import { AdminFormField } from './admin-form-field';

type Props = {
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  name: string;
  expiresAt: string;
  onNameChange: (value: string) => void;
  onExpiryChange: (value: string) => void;
  quantity?: string;
  onQuantityChange?: (value: string) => void;
  acceptedCount?: number;
  canCreate?: boolean;
  canReplay?: boolean;
  title?: string;
  confirmLabel?: string;
  initialFocusRef?: RefObject<HTMLInputElement | null>;
  templateId?: string;
  templateOptions?: readonly { value: string; label: string }[];
  onTemplateChange?: (value: string) => void;
  loadingTemplates?: boolean;
  templateError?: string | null;
  onRetryTemplates?: () => void;
  error?: string | null;
  tencentCloud?: boolean;
};

export function RangeInstanceCreateDialog({ open, pending, onOpenChange, onConfirm, name, expiresAt, onNameChange, onExpiryChange, quantity = '1', onQuantityChange, acceptedCount = 0, canCreate = true, canReplay = false, title = '创建实例', confirmLabel = '确认创建', initialFocusRef, templateId, templateOptions, onTemplateChange, loadingTemplates, templateError, onRetryTemplates, error, tencentCloud }: Props) {
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [templateQuery, setTemplateQuery] = useState('');
  useEffect(() => { if (!open) setTemplateQuery(''); }, [open]);
  const templateName = templateOptions?.find((option) => option.value === templateId)?.label;
  return <AdminDialog open={open} pending={pending} title={title} initialFocusRef={initialFocusRef ?? nameRef} onOpenChange={onOpenChange} footer={<>
    <Button disabled={pending} type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
    <Button disabled={!canCreate || pending || loadingTemplates || !!templateError || (templateOptions !== undefined && !templateId)} type="submit" form={formId} formNoValidate={canReplay}>{pending ? '正在创建…' : canReplay ? '查询原请求' : confirmLabel}</Button>
  </>}>
    <form className="grid gap-3" id={formId} onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      {templateOptions ? <AdminFormField label="靶场模板" htmlFor={`${formId}-template`} required>
        <Combobox ariaLabel="靶场模板" id={`${formId}-template`} disabled={pending || canReplay || loadingTemplates} placeholder={loadingTemplates ? '正在读取模板…' : '搜索或选择靶场模板'} value={templateName ?? templateQuery} selectedValue={templateId} options={templateOptions} onValueChange={(value) => { const selected = templateOptions.find((option) => option.value === value); setTemplateQuery(selected?.label ?? value); onTemplateChange?.(selected?.value ?? ''); }} required />
        {templateError ? <AdminNotice tone="error" actions={<Button size="sm" variant="outline" type="button" onClick={onRetryTemplates}>重试</Button>}>{templateError}</AdminNotice> : !loadingTemplates && !templateOptions.length ? <p className="text-xs text-muted-foreground">暂无可用模板，请先在编排中心页创建模板。</p> : null}
      </AdminFormField> : null}
      <AdminFormField label="实例名" htmlFor={`${formId}-name`} required><Input id={`${formId}-name`} aria-label="实例名" ref={initialFocusRef ?? nameRef} disabled={pending || canReplay} value={name} onChange={(event) => onNameChange(event.target.value)} required /></AdminFormField>
      {onQuantityChange ? <AdminFormField label="创建数量" htmlFor={`${formId}-quantity`} required hint="每套独立创建和计费；多套实例名自动追加编号，共用本次到期时间。"><Input id={`${formId}-quantity`} aria-label="编排实例数量" type="number" min="1" max="99" step="1" disabled={pending || canReplay} value={quantity} onChange={(event) => onQuantityChange(event.target.value)} required /></AdminFormField> : null}
      <AdminFormField label="到期时间" htmlFor={`${formId}-expiry`} required hint={tencentCloud ? '到期时间至少在 10 分钟后。' : undefined}><DateTimePicker id={`${formId}-expiry`} aria-label="到期时间" disabled={pending || canReplay} value={expiresAt} onValueChange={onExpiryChange} required /></AdminFormField>
      {Number(quantity) > 1 && (pending || acceptedCount > 0) ? <AdminNotice tone="info">已受理 {acceptedCount} / {quantity} 套；云资源创建进度请在实例列表查看。</AdminNotice> : null}
      {error ? <AdminNotice tone="error">{error}</AdminNotice> : null}
    </form>
  </AdminDialog>;
}
