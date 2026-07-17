import { BillingScreen } from '../../../components/admin/billing-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function BillingPage() {
  return <BillingScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
