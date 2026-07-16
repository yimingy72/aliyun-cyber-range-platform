import { AdminLoginScreen } from '../../../components/auth/admin-login-screen';
import { resolveAdminOidcClientId, resolveAdminOidcIssuer } from '../../../lib/admin-oidc-config';

export default function AdminLoginPage() {
  return <AdminLoginScreen oidcIssuer={resolveAdminOidcIssuer()} oidcClientId={resolveAdminOidcClientId()} />;
}
