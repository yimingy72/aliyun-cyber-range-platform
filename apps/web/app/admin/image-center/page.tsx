import { ImageCenterScreen } from '../../../components/admin/image-center-screen';
import { resolveAdminApiBaseUrl } from '../../../lib/admin-api-base-url';

export default function ImageCenterPage() {
  return <ImageCenterScreen apiBaseUrl={resolveAdminApiBaseUrl()} />;
}
