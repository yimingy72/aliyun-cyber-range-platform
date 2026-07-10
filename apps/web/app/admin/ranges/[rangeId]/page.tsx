import { RangeInstanceDetailScreen } from '../../../../components/admin/range-instance-detail-screen';
import { resolveAdminApiBaseUrl } from '../../../../lib/admin-api-base-url';

export default async function AdminRangeDetailPage({
  params,
}: {
  params: Promise<{ rangeId: string }>;
}) {
  const { rangeId } = await params;

  return <RangeInstanceDetailScreen apiBaseUrl={resolveAdminApiBaseUrl()} rangeId={rangeId} />;
}
