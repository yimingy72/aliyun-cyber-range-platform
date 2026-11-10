'use client';

import { AdminNotice } from './shared/admin-notice';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { formatAdminDateTime, isUnauthorizedAdminError } from '@/lib/admin-screen';
import { fetchBillingEntryDetail, readCachedBillingDetail, type BillingAmount, type BillingCharge, type BillingEntry, type BillingEntryDetail, type BillingRange, type BillingRequestContext, type BillingDocumentStatus } from '@/lib/billing-lifecycle-api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { Skeleton } from '../ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { formatMoney } from './billing-workbench-utils';
import { formatBillingResourceType } from './billing-pending-resources';
import { StatusBadge } from './shared/status-badge';
import { BillingDetailResize, billingDetailStyle } from './billing-detail-resize';

export const billingDocumentLabels: Record<BillingDocumentStatus,string> = { issued:'已出账',partial:'部分出账',unissued:'未出账',not_applicable:'无需出账',pending:'待核验' };
export const billingReconciliationLabels: Record<BillingEntry['reconciliationStatus'],string> = { current:'已出账',partial:'部分出账',waiting:'未出账',no_bill:'未出账',query_error:'待确认',source_pending:'待确认' };
export function entryBillingStatus(entry: BillingEntry): BillingDocumentStatus {
  return entry.billingStatus ?? (entry.amounts.length || entry.coveredByEntryId ? entry.reconciliationStatus==='current'?'issued':'partial'
    : entry.billingNotRequired ? 'not_applicable' : ['source_pending','query_error'].includes(entry.reconciliationStatus) ? 'pending' : 'unissued');
}
export function BillingAmounts({amounts,emptyLabel='—'}:{amounts:BillingAmount[];emptyLabel?:string}) {
  return amounts.length?<>{amounts.map(amount=>{const text=formatMoney(amount.pretaxAmountExact??amount.pretaxAmount,amount.currency);return <span className="block truncate tabular-nums" key={amount.currency} title={text}>{text}</span>;})}</>:<span className="text-muted-foreground">{emptyLabel}</span>;
}
export function BillingDocumentBadge({entry}:{entry:BillingEntry}) {
  const status=entryBillingStatus(entry);
  return <Badge data-dense-tone={status==='issued'?'success':status==='partial'||status==='pending'?'warning':undefined} variant={status==='issued'?'secondary':status==='partial'?'default':'outline'} title={status==='unissued'?'尚未取得可确认归属的官方费用明细':status==='not_applicable'?'已确认创建在计费资源产生前失败':status==='pending'?entry.issueMessage??'计费资源或查询结果待核验':undefined}>{billingDocumentLabels[status]}</Badge>;
}
export function BillingReconciliationBadge({status}:{status:BillingEntry['reconciliationStatus']}) {
  return <Badge variant={status==='current'?'secondary':'outline'}>{billingReconciliationLabels[status]}</Badge>;
}
export function canActivateBillingRow(event:MouseEvent<HTMLElement>) {
  if(event.defaultPrevented||event.target instanceof Element&&event.target.closest('button,a'))return false;
  const selection=event.currentTarget.ownerDocument.getSelection();
  return !selection||selection.isCollapsed||!selection.containsNode(event.currentTarget,true);
}
const resourceLabels: Record<string,string>={issued:'已出账',covered_by_parent:'合并计费',partial:'部分出账',awaiting_query:'未出账',no_bill:'未出账',query_error:'待确认',source_pending:'待确认'};
const chargeLabels: Record<string,string>={issued:'已出账',unissued:'未出账',unknown:'待确认',not_returned:'暂无明细'};
const lifeLabels:Record<string,string>={creating:'创建中',active:'使用中',partially_released:'部分回收',released:'已回收',failed:'创建 / 回收失败',allocation_ended:'费用归属已结束'};
const billingPeriod=(charge:BillingCharge)=>charge.billingFrom?charge.billingFrom+(charge.billingTo&&charge.billingTo!==charge.billingFrom?` — ${charge.billingTo}`:''):null;
const componentOrder: Record<string,number> = {'云服务器配置':0,'系统盘':1,ImageOS:2,'网关类型（实例费）':0,'容量单位（CU费）':1};
const componentLabels: Record<string,string> = {'云服务器配置':'实例费','系统盘':'系统盘费',ImageOS:'镜像费','网关类型（实例费）':'网关实例费','容量单位（CU费）':'CU 费'};
const resourceOrder: Record<string,number> = {ecs:0,disk:1,nat_gateway:2,eip:3};
const resourceColumns='grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-x-3 px-3 @min-[27rem]/billing:grid-cols-[minmax(0,1fr)_8rem_4rem_4rem] @min-[27rem]/billing:gap-x-4 @min-[27rem]/billing:px-5';
const amountCell='text-right [overflow-wrap:anywhere] [&_span]:whitespace-normal';
const detailSurface='@container/billing rounded-lg border border-border bg-card text-xs leading-4';
const detailHeading='hidden rounded-t-lg bg-muted py-2.5 text-muted-foreground';
const ledgerColumns='grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-x-3 px-3 @min-[38rem]/billing:grid-cols-[minmax(0,1fr)_11.5rem_5rem_8rem] @min-[38rem]/billing:gap-x-4 @min-[38rem]/billing:px-5';
const eventColumns='grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 @min-[28rem]/billing:grid-cols-[11.5rem_minmax(0,1fr)_5rem] @min-[28rem]/billing:gap-x-4 @min-[28rem]/billing:px-5';

function chargeCaption(charge: BillingCharge) {
  const name = componentLabels[charge.name]??charge.name;
  return name + (charge.transactionType==='Refund'&&!/退款|refund/i.test(name)?' · 退款':charge.transactionType==='Adjustment'&&!/调账|adjustment/i.test(name)?' · 调账':'');
}

function BillingChargeDetails({id,charges,resourceId,model}:{id:string;charges:BillingCharge[];resourceId?:string;model?:string}) {
  const first=charges[0],period=billingPeriod(first);
  const sharedPeriod=charges.every(charge=>billingPeriod(charge)===period)?period:null;
  const sharedMessage=charges.every(charge=>charge.message===first.message)?first.message:null;
  const usageCharges=charges.filter(charge=>charge.usage!==null);
  const natUsage=first.resourceType==='nat_gateway'&&usageCharges.length===1&&usageCharges[0].usageUnit==='CU'?usageCharges[0]:null;
  const basis=[['资源 ID',resourceId],['型号',model],['账期',sharedPeriod],['CU 用量',natUsage?natUsage.usage+' CU':null]].filter(([,value])=>value);
  return <div id={id} className={`grid ${resourceColumns} border-t border-border bg-muted/40 py-3`}>
    <div className="col-span-full grid min-w-0 gap-x-6 gap-y-3 @min-[34rem]/billing:col-span-2 @min-[32rem]/billing:grid-cols-2">
      {basis.length?<section aria-label="计费依据" className="min-w-0">
        <h3 className="mb-2 font-semibold">计费依据</h3>
        <dl className="grid gap-1.5">{basis.map(([label,value])=><div key={label} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2">
          <dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums [overflow-wrap:anywhere]">{value}</dd>
        </div>)}</dl>
      </section>:null}
      <section aria-label="费用组成" className={basis.length?'min-w-0 border-t border-border pt-3 @min-[32rem]/billing:border-0 @min-[32rem]/billing:pt-0':'col-span-full min-w-0'}>
        <h3 className="mb-2 font-semibold">费用组成</h3>
        <dl className="grid gap-1.5">{[...charges].sort((a,b)=>(componentOrder[a.name]??3)-(componentOrder[b.name]??3)).map(charge=>{
          const chargePeriod=sharedPeriod?null:billingPeriod(charge);
          const usage=charge.usage!==null&&charge!==natUsage?[charge.usage,charge.usageUnit].filter(Boolean).join(' '):null;
          return <div key={charge.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] items-baseline gap-x-3">
            <dt className="text-muted-foreground [overflow-wrap:anywhere]" title={charge.name}>
              <span>{chargeCaption(charge)}</span>{usage?<span className="ml-2 inline-block">用量：{usage}</span>:null}
              {chargePeriod?<span className="block">账期：{chargePeriod}</span>:null}
              {!sharedMessage&&charge.message?<span className="block">{charge.message}</span>:null}
            </dt>
            <dd className={`${amountCell} font-medium`}><BillingAmounts amounts={charge.amounts} emptyLabel={chargeLabels[charge.status]}/></dd>
          </div>;
        })}</dl>
        {sharedMessage?<p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">{sharedMessage}</p>:null}
      </section>
    </div>
  </div>;
}

function billingResourcePeriod({billingStartAt,releasedAt,allocationEndedAt}:BillingEntryDetail['resources'][number]) {
  const start=formatAdminDateTime(billingStartAt),endedAt=releasedAt??allocationEndedAt;
  if(!endedAt)return [start,'持续使用中'];
  const end=formatAdminDateTime(endedAt);
  const [startDay,startClock]=start.split(' '),[endDay,endClock]=end.split(' ');
  return startDay===endDay&&startClock&&endClock?[startDay,`${startClock} 至 ${endClock}`]:[start,end];
}

function BillingRelatedResources({resources,emptyMessage}:{resources:BillingEntryDetail['resources'];emptyMessage?:string|null}) {
  if(!resources.length)return <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage??'资源创建记录尚待确认。'}</p>;
  return <div className={detailSurface}>
    <div aria-hidden="true" className={`${detailHeading} ${ledgerColumns} @min-[38rem]/billing:grid`}>
      <span>资源 / 地域</span><span>使用期间</span><span>出账情况</span><span className="text-right">已关联金额</span>
    </div>
    <ul role="list" aria-label="关联计费资源" className="divide-y divide-border">
      {resources.map(resource=>{
        const [start,end]=billingResourcePeriod(resource);
        return <li key={resource.ledgerId} className={`grid ${ledgerColumns} items-start gap-y-1 py-2.5`}>
          <div className="col-span-full row-start-1 min-w-0 [overflow-wrap:anywhere] @min-[38rem]/billing:col-span-1">
            <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-[13px] font-semibold">{formatBillingResourceType(resource.cloudResourceType)}</span>{resource.regionId?<span className="text-muted-foreground">{resource.regionId}</span>:null}</div>
            <div className="mt-0.5 text-muted-foreground">{resource.cloudResourceId}</div>
          </div>
          <div className="col-span-full row-start-2 flex min-w-0 flex-wrap gap-x-2 tabular-nums @min-[38rem]/billing:col-span-1 @min-[38rem]/billing:col-start-2 @min-[38rem]/billing:row-start-1 @min-[38rem]/billing:block">
            <span className="sr-only">使用期间：</span><div>{start}</div><div className="text-muted-foreground">{end}</div>
          </div>
          <Badge className="col-start-1 row-start-3 justify-self-start @min-[38rem]/billing:col-start-3 @min-[38rem]/billing:row-start-1"
            variant={['issued','covered_by_parent'].includes(resource.state)?'secondary':resource.state==='partial'?'default':'outline'}>{resourceLabels[resource.state]??'待确认'}</Badge>
          <div className={`${amountCell} col-start-2 row-start-3 font-medium @min-[38rem]/billing:col-start-4 @min-[38rem]/billing:row-start-1`}>
            <span className="sr-only">已关联金额：</span>
            {resource.state==='covered_by_parent'&&!resource.amounts.length?<span className="font-normal text-muted-foreground">已包含在关联费用内</span>:<BillingAmounts amounts={resource.amounts}/>}
          </div>
          {resource.reasonMessage?<p className="col-span-full mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{resource.reasonMessage}</p>:null}
        </li>;
      })}
    </ul>
  </div>;
}

function BillingOperationHistory({bill,events}:{bill:BillingEntry;events:BillingEntryDetail['events']}) {
  const milestones=[['创建时间',bill.createdAt],['计划回收',bill.plannedExpiresAt],['实际回收',bill.releaseConfirmedAt]];
  return <div className="grid gap-3">
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-4">
      {milestones.map(([label,at])=>at?<div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 tabular-nums"><time dateTime={at}>{formatAdminDateTime(at)}</time></dd></div>:null)}
    </dl>
    {events.length?<div className={detailSurface}>
      <div aria-hidden="true" className={`${detailHeading} ${eventColumns} @min-[28rem]/billing:grid`}><span>时间</span><span>操作</span><span className="text-right">状态</span></div>
      <ol role="list" aria-label="操作轨迹" className="divide-y divide-border">{events.map(event=><li key={event.id} className={`grid ${eventColumns} items-baseline gap-y-1 py-2`}>
        <time className="col-start-1 row-start-1 text-muted-foreground tabular-nums" dateTime={event.at}>{formatAdminDateTime(event.at)}</time>
        <div className="col-start-1 row-start-2 min-w-0 @min-[28rem]/billing:col-start-2 @min-[28rem]/billing:row-start-1">
          <span className="font-medium [overflow-wrap:anywhere]">{event.title}</span>
          {event.requestedExpiresAt!==undefined?<p className="mt-0.5 text-muted-foreground">回收时间：{event.requestedExpiresAt?formatAdminDateTime(event.requestedExpiresAt):'未设置'}</p>:null}
        </div>
        <div className="col-start-2 row-start-2 justify-self-end @min-[28rem]/billing:col-start-3 @min-[28rem]/billing:row-start-1"><StatusBadge status={event.status}/></div>
      </li>)}</ol>
    </div>:<p className="py-8 text-center text-sm text-muted-foreground">暂无操作记录。</p>}
  </div>;
}

export function BillingEntryDetails({context,entry,range,revision,container,onOpenChange,onUnauthorized}:{
  context:BillingRequestContext;entry:BillingEntry;range:BillingRange;revision:number;container?:HTMLElement|null;onOpenChange:(open:boolean)=>void;onUnauthorized:()=>void;
}) {
  const panel = useRef<HTMLDivElement>(null), panelId = useId();
  const [panelStyle] = useState(billingDetailStyle);
  const key=JSON.stringify([context,entry.id,range.startAt,range.endAt]);
  const [snapshot,setSnapshot]=useState<{key:string;detail:BillingEntryDetail}|null>(null);
  const detail=snapshot?.key===key?snapshot.detail:readCachedBillingDetail(context,entry.id,range)??null;
  const [loading,setLoading]=useState(!detail),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const [expandedCharges,setExpandedCharges]=useState<Set<string>>(new Set());
  const previousRevision=useRef(revision);
  useEffect(()=>{
    let current=true;const controller=new AbortController();setLoading(true);setError(false);
    const refresh=previousRevision.current!==revision||attempt>0;previousRevision.current=revision;
    fetchBillingEntryDetail(context,entry.id,range,controller.signal,{refresh}).then(value=>{if(current)setSnapshot({key,detail:value});}).catch(failure=>{
      if(!current)return;if(isUnauthorizedAdminError(failure))onUnauthorized();else setError(true);
    }).finally(()=>{if(current)setLoading(false);});
    return()=>{current=false;controller.abort();};
  },[context,entry.id,range.startAt,range.endAt,key,revision,attempt,onUnauthorized]);
  const bill=detail?.entry??entry;
  const resourceFees=new Map((detail?.resourceFees??[]).map(row=>[JSON.stringify([row.resourceType,row.resourceId]),row]));
  const chargeGroups=new Map<string,BillingCharge[]>();
  for(const charge of detail?.charges??[]){
    const id=JSON.stringify([charge.resourceType,charge.resourceId]);
    const group=chargeGroups.get(id)??[];group.push(charge);chargeGroups.set(id,group);
  }
  return <Sheet open onOpenChange={onOpenChange} modal={false}>
    <SheetContent ref={panel} id={panelId} portalContainer={container} style={panelStyle}
      className={`${container?'absolute rounded-md border border-border':''} shadow-lg data-[side=right]:w-full data-[side=right]:sm:w-[var(--billing-detail-width)] data-[side=right]:sm:max-w-none motion-reduce:animate-none`}
      showCloseButton={false} aria-describedby="billing-detail-description">
      <SheetHeader className="shrink-0 gap-1.5 border-b border-border p-3 sm:p-4">
        <div className="flex min-h-7 items-center gap-2">
          <SheetTitle className="min-w-0 flex-1 font-heading text-lg font-semibold [overflow-wrap:anywhere]">{bill.name}</SheetTitle>
          <BillingDocumentBadge entry={bill}/>
          <SheetClose asChild><Button aria-label="关闭账单详情" size="icon-sm" variant="ghost"><X className="size-4"/></Button></SheetClose>
        </div>
        <SheetDescription id="billing-detail-description" className="sr-only">账目费用明细、关联资源和操作记录</SheetDescription>
        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground"><dt className="sr-only">账期</dt><dd>{range.startAt} 至 {range.endAt}</dd>{loading&&detail?<RefreshCw aria-label="正在刷新账单详情" className="size-3 animate-spin"/>:null}</div>
          <div className="flex min-w-0 items-baseline gap-2"><dt className="shrink-0 text-muted-foreground">已出账</dt><dd className="min-w-0 text-sm font-semibold"><BillingAmounts amounts={bill.amounts}/></dd></div>
          <div><dt className="sr-only">关联资源</dt><dd>{bill.resourceCount} 项资源</dd></div>
          <div><dt className="sr-only">使用状态</dt><dd>{lifeLabels[bill.lifecycleStatus]??bill.lifecycleStatus}</dd></div>
        </dl>
        {bill.sourceInstanceName?<p className="truncate text-xs text-muted-foreground" title={bill.sourceInstanceName}>来源实例：{bill.sourceInstanceName}</p>:null}
      </SheetHeader>
      <BillingDetailResize panel={panel} panelId={panelId}/>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4" aria-label="账单详情内容" aria-busy={loading||undefined}>
        {error?<AdminNotice tone="error" className="mb-4" actions={<Button type="button" variant="outline" size="sm" onClick={()=>setAttempt(value=>value+1)}>重试详情</Button>}>详情加载失败{detail?'，暂时显示上次数据':'。'}</AdminNotice>:null}
        {!detail&&loading?<div aria-label="正在加载费用明细" className="grid gap-3"><Skeleton className="h-8 w-64"/>{[0,1,2,3].map(id=><Skeleton key={id} className="h-12 w-full"/>)}</div>:null}
        {detail?<Tabs defaultValue="charges" className="gap-3">
          <TabsList variant="line" className="h-8 w-full justify-start gap-0 border-b border-border sm:gap-2"><TabsTrigger className="flex-1 px-1 sm:flex-none sm:px-3" value="charges">费用明细</TabsTrigger><TabsTrigger className="flex-1 px-1 sm:flex-none sm:px-3" value="resources">关联资源</TabsTrigger><TabsTrigger className="flex-1 px-1 sm:flex-none sm:px-3" value="events">操作记录</TabsTrigger></TabsList>
          <TabsContent value="charges" className="min-w-0">
            {chargeGroups.size?<div className={detailSurface}>
              <div aria-hidden="true" className={`${resourceColumns} ${detailHeading} @min-[27rem]/billing:grid`}>
                <span>计费资源</span><span className="text-right">已出账小计</span><span className="text-center">状态</span>
              </div>
              <ul role="list" aria-label="计费资源" className="divide-y divide-border">
                {[...chargeGroups].sort(([,a],[,b])=>(resourceOrder[a[0].resourceType]??4)-(resourceOrder[b[0].resourceType]??4)).map(([id,charges],index)=>{
                  const {resourceId,resourceType}=charges[0],isEcs=resourceType==='ecs';
                  const fee=resourceFees.get(id),spec=fee?.specification,expanded=expandedCharges.has(id),detailsId=`${panelId}-fees-${index}`;
                  const specText=spec?[spec.cpu&&`${spec.cpu} 核`,spec.memory,spec.systemDisk&&`系统盘 ${spec.systemDisk}`].filter(Boolean).join(' · '):'';
                  const status=charges.every(charge=>charge.status==='issued')?'issued':charges.some(charge=>charge.status==='issued')?'partial'
                    :charges.some(charge=>charge.status==='unknown')?'unknown':charges.some(charge=>charge.status==='unissued')?'unissued':'not_returned';
                  const toggle=()=>setExpandedCharges(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});
                  return <li key={id}>
                    <div className={`grid ${resourceColumns} min-h-16 cursor-pointer items-center gap-y-1 py-2.5 hover:bg-muted/50`}
                      onClick={event=>{if(canActivateBillingRow(event))toggle();}}>
                      <div className="col-start-1 row-start-1 min-w-0">
                        <div className="text-[13px] font-semibold">{formatBillingResourceType(resourceType)}</div>
                        <div className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{isEcs?(fee?.configurationChanged?'账期内规格有变化':specText||spec?.instanceType||'规格未记录'):resourceId}</div>
                      </div>
                      <div className={`${amountCell} col-start-2 row-start-1 font-semibold`} data-slot="billing-resource-subtotal"><span className="sr-only">已出账小计</span><BillingAmounts amounts={fee?.amounts??[]}/></div>
                      <Badge className="col-start-2 row-start-2 justify-self-end @min-[27rem]/billing:col-start-3 @min-[27rem]/billing:row-start-1 @min-[27rem]/billing:justify-self-center" variant={status==='issued'?'secondary':status==='partial'?'default':'outline'}>{status==='partial'?'部分出账':chargeLabels[status]}</Badge>
                      <Button type="button" variant="outline" size="sm" aria-label={`${expanded?'收起':'展开'} ${resourceId} 计费详情`} aria-expanded={expanded} aria-controls={expanded?detailsId:undefined}
                        className="col-start-1 row-start-2 min-w-16 justify-self-start px-2 text-xs @min-[27rem]/billing:col-start-4 @min-[27rem]/billing:row-start-1 @min-[27rem]/billing:justify-self-end [@media(pointer:coarse)]:min-h-11"
                        onClick={toggle}>{expanded?'收起':'明细'}<ChevronDown aria-hidden="true" className={expanded?'size-3 rotate-180':'size-3'}/></Button>
                    </div>
                    {expanded?<BillingChargeDetails id={detailsId} charges={charges} resourceId={isEcs?resourceId:undefined}
                      model={specText&&!fee?.configurationChanged?spec?.instanceType:undefined}/>:null}
                  </li>;
                })}
              </ul>
            </div>:null}
            {!detail.charges?.length?<p className="py-8 text-center text-sm text-muted-foreground">{entryBillingStatus(bill)==='not_applicable'?'未产生计费资源，无需等待出账。':'尚未取得可归属的官方费用明细。'}</p>:null}
            {bill.coveredByEntryId?<p className="mt-3 text-xs text-muted-foreground">费用已计入关联的快照合并账单，不重复累计。</p>:null}
            {bill.issueMessage?<p className="mt-3 text-xs text-muted-foreground">{bill.issueMessage}</p>:null}
          </TabsContent>
          <TabsContent value="resources" className="min-w-0">
            <BillingRelatedResources resources={detail.resources} emptyMessage={bill.issueMessage}/>
          </TabsContent>
          <TabsContent value="events" className="min-w-0">
            <BillingOperationHistory bill={bill} events={detail.events}/>
          </TabsContent>
        </Tabs>:null}
      </div>
    </SheetContent>
  </Sheet>;
}
