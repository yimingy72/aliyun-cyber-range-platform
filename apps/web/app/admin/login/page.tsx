import { AdminLoginScreen } from '../../../components/auth/admin-login-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminLoginPage() {
  return <AdminLoginScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
