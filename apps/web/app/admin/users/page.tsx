import { UsersScreen } from '../../../components/admin/users-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminUsersPage() {
  return <UsersScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
