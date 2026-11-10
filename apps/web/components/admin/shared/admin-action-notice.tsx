'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { overlayContainer } from '@/lib/overlay-container';
import { AdminNotice, type AdminNoticeTone } from './admin-notice';

export function AdminActionNotice({ message, onDismiss, tone = 'success' }: {
  message: string | null;
  onDismiss: () => void;
  tone?: AdminNoticeTone;
}) {
  const dismissRef = useRef(onDismiss);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [container, setContainer] = useState<Element | null>(null);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    const syncContainer = () => setContainer(overlayContainer() ?? document.getElementById('admin-notice-stack') ?? document.body);
    syncContainer();
    document.addEventListener('fullscreenchange', syncContainer);
    return () => document.removeEventListener('fullscreenchange', syncContainer);
  }, [message]);

  useEffect(() => {
    if (!message) {
      setHovered(false);
      setFocused(false);
      return;
    }
    if (hovered || focused || tone === 'error' || tone === 'warning') return;
    const timer = window.setTimeout(() => dismissRef.current(), 5000);
    return () => window.clearTimeout(timer);
  }, [focused, hovered, message, tone]);

  if (!message || !container) return null;

  return createPortal(
    <AdminNotice
      className="admin-action-notice"
      tone={tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      actions={<Button type="button" variant="ghost" size="icon-sm" aria-label="关闭操作提示" onClick={onDismiss}><X aria-hidden="true" /></Button>}
    >
      {message}
    </AdminNotice>,
    container,
  );
}
