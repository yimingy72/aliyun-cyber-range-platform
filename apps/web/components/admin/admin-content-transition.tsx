'use client';

import type { ReactNode } from 'react';

type AdminContentTransitionProps = {
  pathname: string;
  children: ReactNode;
  hidden?: boolean;
  testId?: string | null;
};

export function AdminContentTransition({
  pathname,
  children,
  hidden = false,
  testId = 'admin-content-transition',
}: AdminContentTransitionProps) {
  return (
    <div
      className="admin-content-transition"
      data-route={pathname}
      data-testid={testId ?? undefined}
      hidden={hidden}
      key={pathname}
    >
      {children}
    </div>
  );
}
