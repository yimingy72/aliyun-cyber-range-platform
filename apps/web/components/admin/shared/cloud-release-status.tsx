import type { HostCloudReleaseDeadline } from '@aliyun-cyber-range/platform-api-client';
import { formatAdminDateTime } from '@/lib/admin-screen';

export function CloudReleaseStatus({ deadline }: { deadline?: HostCloudReleaseDeadline }) {
  return <span className="mt-1 block text-xs text-muted-foreground" title={deadline?.reason ? '云端截止配置或系统盘随主机释放属性尚未核验；平台仍按到期时间回收。' : undefined}>
    {deadline ? <>云端 {formatAdminDateTime(deadline.cloudReleaseAt)}<span className={`ml-1 ${deadline.status === 'verified' ? 'text-emerald-800' : 'text-amber-800'}`}>{deadline.status === 'verified' ? '已核验' : deadline.status === 'not_configured' ? '未配置' : '待核验'}</span></> : '云端兜底待核验'}
  </span>;
}

export function CloudReleaseSummary({ deadlines, hostIds }: {
  deadlines?: Record<string, HostCloudReleaseDeadline>; hostIds?: Record<string, string> | null;
}) {
  const keys = Object.keys(hostIds ?? {});
  const verified = keys.filter(key => deadlines?.[key]?.status === 'verified' && deadlines[key].instanceId === hostIds?.[key]).length;
  return <span className={verified && verified === keys.length ? 'text-emerald-800' : 'text-amber-800'}>{keys.length ? `${verified}/${keys.length} 台已核验` : '待核验'}</span>;
}
