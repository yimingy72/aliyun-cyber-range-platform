import { ResourceAlertsScreen } from '@/components/admin/resource-alerts-screen';
import { resolveAdminApiBaseUrl } from '@/lib/admin-api-base-url';

export default function ResourceAlertsPage() {
  return <ResourceAlertsScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
