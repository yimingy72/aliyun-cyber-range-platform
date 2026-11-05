'use client';

import { useEffect, useState } from 'react';
import type { BillingReconciliationResource } from '@aliyun-cyber-range/platform-api-client';
import { formatAdminDateTime } from '../../lib/admin-screen';
import { AdminPaginationControls, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { AdminDataTable, AdminDataTableCell, type AdminDataColumn } from './shared/admin-data-table';
import { TableRow } from '@/components/ui/table';

const COLUMNS: readonly AdminDataColumn[] = [
  { id: 'resource', label: '资源 / 云账号', priority: 'primary', width: '15rem' },
  { id: 'owner', label: '所属用户 / 实例', priority: 'primary', width: '15rem' },
  { id: 'period', label: '资源计费起止', priority: 'primary', width: '13rem' },
  { id: 'reason', label: '待补齐原因', priority: 'primary' },
];

export function formatBillingResourceType(type: string) {
  const labels: Record<string, string> = {
    ecs: 'ECS 实例', disk: '系统盘 / 数据盘', eip: '弹性公网 IP', nat_gateway: 'NAT 网关',
    snat_entry: 'SNAT 条目', dnat_entry: 'DNAT 条目', image: '自定义镜像', snapshot: '快照',
    snapshot_region: '快照链容量', oss_bucket: '对象存储桶', unknown: '未知类型',
  };
  return labels[type] ?? type;
}

const reasonLabels: Record<BillingReconciliationResource['proofFailureReason'], string> = {
  BILL_DETAILS_PENDING: '尚未匹配到完整的官方资源费用明细，金额待补齐。',
  BILL_SYNC_DEFERRED: '本次官方分账未核实，保留上次已核验金额，等待完整明细。',
  SYSTEM_DISK_MAPPING_UNVERIFIED: '主机已有系统盘收费组件，但盘与主机的准确映射待核验，不重复计算费用。',
  ACCOUNT_UID_MISSING: '历史记录缺少云账号 UID，费用归属待核验。',
  IMAGE_OR_STORAGE_SOURCE_PROOF_INCOMPLETE: '镜像或存储资源的创建来源证明不完整。',
  SOURCE_RANGE_MISSING: '缺少原始实例关联。',
  SOURCE_JOB_MISSING: '缺少原始创建作业关联。',
  SOURCE_PROOF_UNVERIFIED: '原始创建来源证明尚未核验。',
  SOURCE_JOB_NOT_FOUND: '未找到原始创建作业记录。',
  SOURCE_JOB_WORKSPACE_MISMATCH: '原始作业与资源所属工作空间不一致。',
  SOURCE_JOB_RANGE_MISMATCH: '原始作业与资源所属实例不一致。',
  SOURCE_JOB_NOT_CREATION: '关联作业不能证明资源由平台创建。',
  SOURCE_JOB_CREATION_INVENTORY_MISSING: '原始创建作业缺少资源库存证明。',
  SOURCE_CREATION_PROOF_CONFLICT: '创建库存与资源来源证明存在冲突。',
  SOURCE_RESOURCE_NOT_IN_CREATION_INVENTORY: '原始创建库存未包含该资源。',
  SOURCE_SNAPSHOT_INVENTORY_OR_BILL_PROOF_INCOMPLETE: '镜像依赖快照清单或官方费用证明待补齐。',
};

function resourceTime(value: string) {
  return Number.isFinite(Date.parse(value)) ? formatAdminDateTime(value) : '时间待核实';
}

export function BillingPendingResources({ resources, resourceCount, userNameById, label }: {
  resources?: BillingReconciliationResource[];
  resourceCount: number;
  userNameById: ReadonlyMap<string, string>;
  label: string;
}) {
  const [page, setPage] = useState(1);
  const { pageSize, setPageSize } = useAdminPageSize();
  const rows = resources ?? [];
  const pagination = getPagination(rows.length, page, pageSize);
  useEffect(() => setPage(pagination.page), [pagination.page]);

  return (
    <div className="min-w-0 text-xs text-foreground">
      <p className="py-2 leading-5 text-muted-foreground">按当前所选账期列出资源及待补齐原因。没有完整官方明细的金额不按零计算，也不作估算。</p>
      {resources === undefined || rows.length !== resourceCount ? (
        <p className="mb-2 leading-5 text-muted-foreground" role="status">
          {resources === undefined ? '当前接口尚未提供资源清单，请刷新或更新服务后重试。'
            : `当前仅返回 ${rows.length} 条资源记录，汇总为 ${resourceCount} 项；清单尚不完整，不能据此认为其余资源已补齐。`}
        </p>
      ) : !rows.length ? <p className="py-2">当前账期没有待补齐资源。</p> : null}
      {rows.length ? <AdminPaginatedList className="billing-pending-list" footer={
        <AdminPaginationControls label={`${label}分页`} pageSize={pageSize} pagination={pagination}
          onPageSelect={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} />
      }>
          <AdminDataTable columns={COLUMNS} label={label}>
            {columns => rows.slice(pagination.startIndex, pagination.endIndex).map(resource => (
                <TableRow key={resource.resourceKey}>
                  <AdminDataTableCell column={columns[0]} className="align-top whitespace-normal break-words text-xs leading-5">
                    <span className="block font-medium">{formatBillingResourceType(resource.cloudResourceType)}</span>
                    <code className="block break-all">{resource.cloudResourceId || '云资源 ID 待核实'}</code>
                    <span className="block text-muted-foreground">{resource.cloudProvider === 'tencent_cloud' ? '腾讯云' : '阿里云'} · {resource.regionId || '地域待核实'}</span>
                    <span className="block break-all text-muted-foreground">账号 {resource.cloudAccountUid || '待核实'}</span>
                  </AdminDataTableCell>
                  <AdminDataTableCell column={columns[1]} className="align-top whitespace-normal break-words text-xs leading-5">
                    <span className="block font-medium">{resource.ownerUserId ? userNameById.get(resource.ownerUserId) || resource.ownerUserId : '未记录用户'}</span>
                    <span className="block break-all">实例：{resource.rangeInstanceId || '无实例关联'}</span>
                    <span className="block break-all text-muted-foreground">作业：{resource.sourceProvisionJobId || '未记录'}</span>
                    <span className="block break-all text-muted-foreground">来源：{resource.resourceKey}</span>
                  </AdminDataTableCell>
                  <AdminDataTableCell column={columns[2]} className="align-top whitespace-normal text-xs leading-5">
                    <span className="block">开始：{resourceTime(resource.billingStartAt)}</span>
                    <span className="block">释放：{resource.releasedAt ? resourceTime(resource.releasedAt) : '未记录释放'}</span>
                  </AdminDataTableCell>
                  <AdminDataTableCell column={columns[3]} className="align-top whitespace-normal break-words text-xs leading-5"><p>{reasonLabels[resource.proofFailureReason] || '来源或费用明细仍待核实。'}</p></AdminDataTableCell>
                </TableRow>
              ))}
          </AdminDataTable>
      </AdminPaginatedList> : null}
    </div>
  );
}
