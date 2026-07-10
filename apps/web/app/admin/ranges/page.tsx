import { RangeInstancesScreen } from '../../../components/admin/range-instances-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function AdminRangesPage() {
  return <RangeInstancesScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
