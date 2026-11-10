import { notFound } from 'next/navigation';
import { UsersScreen } from '../../../components/admin/users-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminUsersPage() {
  if (process.env.NEXT_PUBLIC_PLATFORM_AUTH_MODE === 'keycloak') notFound();
  return <UsersScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
