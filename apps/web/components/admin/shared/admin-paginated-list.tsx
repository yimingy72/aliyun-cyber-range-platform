'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type AdminPaginatedListProps = {
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function AdminPaginatedList({ children, className, footer }: AdminPaginatedListProps) {
  return (
    <div className={cn('admin-paginated-list', className)}>
      <div aria-label="列表内容，可滚动" className="admin-paginated-list-body" role="region" tabIndex={0}>{children}</div>
      {footer ? <div className="admin-paginated-list-footer">{footer}</div> : null}
    </div>
  );
}
