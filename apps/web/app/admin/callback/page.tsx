import { AdminOidcCallbackScreen } from '../../../components/auth/admin-oidc-callback-screen';
import { resolveAdminOidcClientId, resolveAdminOidcIssuer } from '../../../lib/admin-oidc-config';

export default function AdminCallbackPage() {
  return <AdminOidcCallbackScreen oidcIssuer={resolveAdminOidcIssuer()} oidcClientId={resolveAdminOidcClientId()} />;
}
