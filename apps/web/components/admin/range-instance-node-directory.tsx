'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, type AdminDataColumn } from './shared/admin-data-table';
import { TableLoadingState } from './shared/table-loading-state';

type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'reset' | 'pack-image';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  statusLabel?: string;
  cloudStatus?: string;
  publicEntry?: { address: string; ports: string[] };
  subnetCidrs?: string[];
  account?: string;
  password?: string;
  imageName?: string;
  expiresAt?: string;
  createdAt?: string;
};

type RangeInstanceNodeDirectoryProps = {
  nodes: RangeInstanceWorkbenchNode[];
  onNodeAction?: (nodeId: string, action: NodeActionName) => void;
  allowActions?: boolean;
  pendingAction?: { nodeId: string; action: NodeActionName } | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
};

const COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '实例名', priority: 'primary', width: '9rem' },
  { id: 'status', label: '状态', priority: 'primary', width: '5rem' },
  { id: 'image', label: '镜像信息', priority: 'primary', width: '11rem' },
  { id: 'address', label: 'IP 地址 / 网段', priority: 'primary', width: '12rem' },
  { id: 'account', label: '账号信息', priority: 'primary', width: '9rem' },
  { id: 'expiry', label: '有效期', priority: 'primary', width: '10rem' },
  { id: 'created', label: '创建时间', priority: 'primary', width: '10rem' },
  { id: 'actions', label: '操作', priority: 'primary', width: '9rem' },
];

export function RangeInstanceNodeDirectory({
  nodes, onNodeAction, allowActions = true, pendingAction = null, isLoading = false, isRefreshing = false,
}: RangeInstanceNodeDirectoryProps) {
  const [copiedPasswordNodeId, setCopiedPasswordNodeId] = useState<string | null>(null);
  const copiedPasswordTimerRef = useRef<number | null>(null);
  const directoryRef = useRef<HTMLDivElement | null>(null);
  const hostNodes = nodes.filter((node) => node.kind === 'ecs');

  useEffect(() => () => {
    if (copiedPasswordTimerRef.current !== null) window.clearTimeout(copiedPasswordTimerRef.current);
  }, []);

  useEffect(() => {
    // Focus the shared table's native scroll container, not a second outer scroller.
    const scroller = directoryRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    scroller?.setAttribute('tabindex', '0');
    scroller?.setAttribute('role', 'region');
    scroller?.setAttribute('aria-label', '实例节点目录，可横向滚动');
  }, []);

  async function handleCopyPassword(node: RangeInstanceWorkbenchNode) {
    if (!node.password?.trim() || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(node.password.trim());
      setCopiedPasswordNodeId(node.id);
      if (copiedPasswordTimerRef.current !== null) window.clearTimeout(copiedPasswordTimerRef.current);
      copiedPasswordTimerRef.current = window.setTimeout(() => {
        setCopiedPasswordNodeId((current) => current === node.id ? null : current);
        copiedPasswordTimerRef.current = null;
      }, 1600);
    } catch {
      // The credential tooltip remains available when the browser denies clipboard access.
    }
  }

  return (
    <div className="range-instance-directory-table" ref={directoryRef}>
      <AdminDataTable columns={COLUMNS} label="实例节点目录" isRefreshing={isRefreshing}
        contentVersion={hostNodes.length}>
        {(columns) => isLoading ? (
          <TableLoadingState columnCount={columns.length} rowCount={2} label="正在获取节点目录" />
        ) : hostNodes.length === 0 ? (
          <AdminDataTableState columns={columns} title="暂无 ECS 节点" description="可在拓扑结构中查看当前网络节点。" variant="empty" />
        ) : hostNodes.map((node) => {
          const isPending = pendingAction?.nodeId === node.id;
          const isStopped = node.cloudStatus === 'Stopped';
          return (
            <TableRow className="range-instance-directory-row" key={node.id}>
              <AdminDataTableCell column={columns[0]!}><strong className="block min-w-0 truncate">{node.label}</strong></AdminDataTableCell>
              <AdminDataTableCell column={columns[1]!}>{node.statusLabel ?? '未知状态'}</AdminDataTableCell>
              <AdminDataTableCell column={columns[2]!}>{node.imageName || '暂无'}</AdminDataTableCell>
              <AdminDataTableCell column={columns[3]!}>
                <div className="range-instance-address-cell">
                  {node.publicEntry ? <>
                    <span className="font-medium text-foreground">{node.publicEntry.address}</span>
                    {node.publicEntry.ports.map((port) => <span key={port}>{port}</span>)}
                  </> : node.subnetCidrs?.length ? node.subnetCidrs.map((cidr) => <span key={cidr}>{cidr}</span>) : <span>暂无关联网段</span>}
                </div>
              </AdminDataTableCell>
              <AdminDataTableCell column={columns[4]!}>
                <div className="flex min-w-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 truncate" tabIndex={0}>{node.account?.trim() || '暂无'} / {node.password?.trim() ? '******' : '暂无'}</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-all">{node.account?.trim() || '暂无'} / {node.password?.trim() || '暂无'}</TooltipContent>
                  </Tooltip>
                  <Button aria-label="复制密码" size="sm" type="button" variant="ghost" className="shrink-0 px-2"
                    disabled={!node.password?.trim()} onClick={() => void handleCopyPassword(node)}>
                    {copiedPasswordNodeId === node.id ? '已复制' : '复制'}
                  </Button>
                </div>
              </AdminDataTableCell>
              <AdminDataTableCell column={columns[5]!}>{node.expiresAt || '暂无'}</AdminDataTableCell>
              <AdminDataTableCell column={columns[6]!}>{node.createdAt || '暂无'}</AdminDataTableCell>
              <AdminDataTableCell column={columns[7]!}>
                {allowActions ? <div className="flex items-center justify-start gap-1">
                  <Button size="sm" variant="outline" disabled={isPending || isStopped} onClick={() => onNodeAction?.(node.id, 'open-vnc')}>
                    {isPending && pendingAction?.action === 'open-vnc' ? '处理中...' : '打开VNC'}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label="更多操作" size="icon-sm" variant="ghost" disabled={isPending}><MoreHorizontal aria-hidden="true" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {isStopped ? <DropdownMenuItem onSelect={() => onNodeAction?.(node.id, 'start')}>开机</DropdownMenuItem> : <>
                        <DropdownMenuItem onSelect={() => onNodeAction?.(node.id, 'stop')}>关机</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onNodeAction?.(node.id, 'reboot')}>重启</DropdownMenuItem>
                      </>}
                      <DropdownMenuItem onSelect={() => onNodeAction?.(node.id, 'reset')}>重置</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onNodeAction?.(node.id, 'pack-image')}>二次打包镜像</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div> : <span>仅查看</span>}
              </AdminDataTableCell>
            </TableRow>
          );
        })}
      </AdminDataTable>
    </div>
  );
}
