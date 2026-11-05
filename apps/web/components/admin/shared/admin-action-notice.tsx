'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AdminActionNotice({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => dismissRef.current(), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (!message || typeof document === 'undefined') return null;
  return createPortal(<div className="admin-action-notice">
    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
    <p role="status" className="min-w-0 flex-1 text-sm leading-5">{message}</p>
    <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭操作提示" onClick={onDismiss} className="-my-1 -mr-1 shrink-0"><X aria-hidden="true" /></Button>
  </div>, document.body);
}
