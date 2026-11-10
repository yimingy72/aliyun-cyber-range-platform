import type { ComponentProps, ReactNode } from 'react';
import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const noticeIcons = { success: Check, info: Info, warning: TriangleAlert, error: CircleAlert };
export type AdminNoticeTone = keyof typeof noticeIcons;

export function AdminNotice({
  tone = 'info',
  className,
  children,
  actions,
  role = tone === 'error' ? 'alert' : 'status',
  ...props
}: ComponentProps<'div'> & { tone?: AdminNoticeTone; actions?: ReactNode }) {
  const Icon = noticeIcons[tone];

  return (
    <div {...props} className={cn('admin-notice', className)} data-slot="admin-notice" data-tone={tone} role={role}>
      <span className="admin-notice-icon" aria-hidden="true"><Icon size={16} /></span>
      <div className="admin-notice-message">{children}</div>
      {actions ? <div className="admin-notice-actions">{actions}</div> : null}
    </div>
  );
}
