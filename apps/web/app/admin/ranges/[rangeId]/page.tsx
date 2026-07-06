import { RangeInstanceDetailScreen } from '../../../../components/admin/range-instance-detail-screen';

export default async function AdminRangeDetailPage({
  params,
}: {
  params: Promise<{ rangeId: string }>;
}) {
  const { rangeId } = await params;

  return <RangeInstanceDetailScreen rangeId={rangeId} />;
}
