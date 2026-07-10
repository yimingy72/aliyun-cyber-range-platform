import type { ReactNode } from 'react';

import { AdminWorkspaceShell } from '../../components/admin/admin-workspace-shell';

export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminWorkspaceShell>{children}</AdminWorkspaceShell>;
}
