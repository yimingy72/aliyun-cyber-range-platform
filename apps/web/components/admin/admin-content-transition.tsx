'use client';

import type { ReactNode } from 'react';

type AdminContentTransitionProps = {
  pathname: string;
  children: ReactNode;
};

export function AdminContentTransition({ pathname, children }: AdminContentTransitionProps) {
  return (
    <div className="admin-content-transition" data-route={pathname} data-testid="admin-content-transition" key={pathname}>
      {children}
    </div>
  );
}
