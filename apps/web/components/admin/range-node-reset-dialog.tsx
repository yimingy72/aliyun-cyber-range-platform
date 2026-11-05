'use client';

import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RangeNodeResetPreview } from '@/lib/admin-types';
import { AdminDialog } from './shared/admin-dialog';

export function RangeNodeResetDialog({nodeName,preview,loading,pending,error,uncertain,onClose,onRetryPreview,onConfirm}:{
  nodeName:string;preview:RangeNodeResetPreview|null;loading:boolean;pending:boolean;error:string|null;uncertain:boolean;
  onClose:()=>void;onRetryPreview:()=>void;onConfirm:(name:string)=>void;
}) {
  const [name,setName]=useState('');
  const cancelRef=useRef<HTMLButtonElement>(null);
  return <AdminDialog open title="重置节点系统盘" size="standard" pending={pending} initialFocusRef={cancelRef}
    description={`将“${nodeName}”的系统盘恢复至原镜像初始状态。系统盘上的文件、应用和修改会永久丢失，请先自行备份。`}
    onOpenChange={open=>{if(!open)onClose();}}
    footer={<><Button ref={cancelRef} variant="outline" disabled={pending} onClick={onClose}>取消</Button>
      <Button variant="destructive" disabled={pending||loading||!preview||name!==preview.nodeName} onClick={()=>onConfirm(name)}>
        {pending?'正在提交…':uncertain?'核对原提交':'确认清空系统盘并重置'}
      </Button></>}>
    <div className="grid gap-4 text-sm">
      {loading?<p role="status">正在只读核验主机、系统盘与原镜像…</p>:null}
      {preview?<><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-all">
        <dt>节点 / ECS</dt><dd>{preview.nodeName} / {preview.instanceId}</dd>
        <dt>系统盘</dt><dd>{preview.systemDiskId}</dd><dt>原镜像</dt><dd>{preview.imageId}</dd>
        <dt>完成后电源</dt><dd>{preview.originalPowerState==='Running'?'恢复运行':'恢复关机'}</dd>
      </dl><p>仅重置此系统盘；保留原 ECS、IP、网络和{preview.dataDiskIds.length?` ${preview.dataDiskIds.length} 块数据盘`:'数据盘'}，不延长有效期。
        {preview.hasDns?'将恢复并核验已部署 DNS；原为关机时会短暂启动。':null}</p>
      <label className="grid gap-2"><span>输入完整节点名称「{preview.nodeName}」确认</span>
        <Input aria-label="确认重置节点名称" autoComplete="off" value={name} disabled={pending} onChange={event=>setName(event.target.value)} /></label></>:null}
      {error?<div role="alert" className="text-destructive"><p>{error}</p>
        {!pending&&!uncertain?<Button variant="outline" className="mt-2" onClick={onRetryPreview}>重新核验</Button>:null}</div>:null}
      {uncertain?<p role="status">提交结果尚未确认。再次操作只核对同一提交，不会生成新的重置请求；也可查看原任务。</p>:null}
    </div>
  </AdminDialog>;
}
