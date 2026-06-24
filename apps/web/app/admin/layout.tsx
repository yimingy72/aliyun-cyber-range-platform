import type { ReactNode } from 'react';

import { AdminWorkspaceShell } from '../../components/admin/admin-workspace-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminWorkspaceShell>{children}</AdminWorkspaceShell>;
}
