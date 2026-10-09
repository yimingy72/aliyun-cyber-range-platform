'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { RangeInstanceNodeDirectory } from './range-instance-node-directory';
import { AdminPageHeader } from './shared/admin-page-header';

export function RangeInstanceDetailBodySkeleton() {
  return <div aria-busy="true" data-testid="range-detail-skeleton" className="range-instance-detail-skeleton">
    <div className="range-instance-overview-grid" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-4 w-full" />)}
    </div>
    <div className="range-instance-detail-toolbar" aria-hidden="true"><Skeleton className="h-8 w-44" /></div>
    <RangeInstanceNodeDirectory nodes={[]} isLoading allowActions={false} />
  </div>;
}

export function RangeInstanceDetailLoading() {
  return <main className="admin-screen range-instance-detail-screen min-w-0">
    <section className="admin-workbench-surface range-instance-detail-workbench">
      <AdminPageHeader title="实例详情" description="查看实例运行状态、节点目录与拓扑编排。" />
      <RangeInstanceDetailBodySkeleton />
    </section>
  </main>;
}
