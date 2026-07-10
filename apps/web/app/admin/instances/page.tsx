import { SingleInstancesScreen } from '../../../components/admin/single-instances-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminInstancesPage() {
  return <SingleInstancesScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
