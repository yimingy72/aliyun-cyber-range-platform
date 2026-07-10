import { TemplatesScreen } from '../../../components/admin/templates-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminScenariosPage() {
  return <TemplatesScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
