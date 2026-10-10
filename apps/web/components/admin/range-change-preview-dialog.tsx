'use client';

import type { RangeInstanceChangePreview } from '@/lib/admin-types';
import { Button } from '@/components/ui/button';
import { AdminDialog } from './shared/admin-dialog';

const resourceLabels: Record<string, string> = { natGateways: 'NAT 网关', eips: '弹性公网 IP', snatEntries: 'SNAT 规则', dnatEntries: 'DNAT 规则' };

export function RangeChangePreviewDialog({ preview, pending, onClose, onConfirm }: {
  preview: RangeInstanceChangePreview | null; pending: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const hasChanges = Boolean(preview && (preview.addedNetworks?.length || preview.addedHosts.length || preview.deletedHosts.length || preview.ruleChanges.length || preview.resourceChanges.length));
  return <AdminDialog open={Boolean(preview)} title="确认应用变更" size="wide" pending={pending}
    description="以下为预计配置变化。新增主机沿用本编排到期时间；删除将回收云主机及随实例删除的磁盘，数据无法恢复。"
    onOpenChange={open => { if (!open && !pending) onClose(); }}
    footer={<><Button disabled={pending} variant="outline" onClick={onClose}>取消</Button><Button disabled={pending || !hasChanges} onClick={onConfirm}>{pending ? '正在提交…' : '确认应用变更'}</Button></>}>
    {preview ? <div className="grid gap-4 text-sm">
      <div className="flex flex-wrap gap-3 border-b border-border pb-3">
        <span>新增网络 <strong>{preview.addedNetworks?.length ?? 0}</strong></span><span>新增主机 <strong>{preview.addedHosts.length}</strong></span><span>回收主机 <strong>{preview.deletedHosts.length}</strong></span><span>修改规则 <strong>{preview.ruleChanges.length}</strong></span>
      </div>
      {!hasChanges ? <p role="status">没有需要应用的配置变化。</p> : null}
      {preview.addedNetworks?.length ? <section><h3 className="mb-2 font-medium">新增网络</h3><ul className="grid gap-2">{preview.addedNetworks.map(network => <li key={network.nodeId}>{network.name} <span className="text-xs text-muted-foreground">{network.cidr}</span></li>)}</ul></section> : null}
      {preview.addedHosts.length ? <section><h3 className="mb-2 font-medium">新增主机</h3><ul className="grid gap-2">{preview.addedHosts.map(host => <li key={host.id}>{host.name} <span className="text-xs text-muted-foreground">({host.nodeId})</span></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">新增资源会产生费用，结束时间与本编排一致。</p></section> : null}
      {preview.deletedHosts.length ? <section><h3 className="mb-2 font-medium text-destructive">回收主机</h3><ul className="grid gap-3">{preview.deletedHosts.map(host => <li key={host.id}>
        <div>{host.name} <span className="break-all text-xs text-muted-foreground">{host.instanceId || host.nodeId}</span></div>
        {host.diskIds?.length ? <p className="mt-1 break-all text-xs text-muted-foreground">关联磁盘：{host.diskIds.join('、')}</p> : null}
        {host.networkInterfaceIds?.length ? <p className="mt-1 text-xs text-muted-foreground">关联网卡：{host.networkInterfaceIds.length} 张</p> : null}
      </li>)}</ul></section> : null}
      {preview.ruleChanges.length ? <section><h3 className="mb-2 font-medium">网络规则</h3><ul className="grid gap-2">{preview.ruleChanges.map(node => <li key={node.nodeId}>{node.name} <span className="text-xs text-muted-foreground">({node.nodeId})</span></li>)}</ul></section> : null}
      {preview.resourceChanges.length ? <section><h3 className="mb-2 font-medium">关联网络资源</h3><ul className="grid gap-2">{preview.resourceChanges.map((resource, index) => <li key={`${resource.key}-${index}`}>
        {resource.action === 'delete' ? '回收' : '新增'}{resourceLabels[resource.resourceType] ?? resource.resourceType} <span className="break-all text-xs text-muted-foreground">{resource.resourceId ?? resource.key}</span>
      </li>)}</ul></section> : null}
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">未列入删除清单的已有主机将保留；原编排模板保持不变。</p>
    </div> : null}
  </AdminDialog>;
}
