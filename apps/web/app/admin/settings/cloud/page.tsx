import { SettingsScreen } from '../../../../components/admin/settings/settings-screen';
import { resolveAdminApiBaseUrl } from '../../../../lib/admin-api-base-url';

export default function CloudSettingsPage() {
  return <SettingsScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
