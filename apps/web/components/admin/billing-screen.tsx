'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CalendarDays, ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react';
import dynamic from 'next/dynamic';
import { AdminApiError, exportBillingUserItemsCsv, exportBillingUsersCsv, exportPlatformBillingCsv, fetchAdminUsers } from '@/lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '@/lib/admin-screen';
import type { AdminUser } from '@/lib/admin-types';
import { billingSessionScope, clearBillingReadCache, fetchBillingEntries, readCachedBillingEntries, type BillingDocumentStatus, type BillingEntriesQuery, type BillingEntriesResult, type BillingEntry, type BillingRange, type BillingRequestContext } from '@/lib/billing-lifecycle-api';
import { readCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
import { Button } from '../ui/button';
import { DateTimePicker, parseLocalDate } from '../ui/date-time-picker';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton } from '../ui/skeleton';
import { TableCell, TableRow } from '../ui/table';
import { AdminPaginationControls, getPagination, useAdminPageSize } from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import { BillingAmounts, BillingDocumentBadge, BillingEntryDetails, billingDocumentLabels, canActivateBillingRow } from './billing-entry-details';
import { downloadCsv, getDefaultRange, LegacyBillingScreen } from './billing-legacy-screen';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { ADMIN_TABLE_WIDTHS, AdminDataTable, AdminDataTableCell, AdminDataTableText, type AdminDataColumn } from './shared/admin-data-table';
import { usePlatformTheme } from './platform-theme-menu';
import { AdminWorkbenchControls } from './shared/admin-workbench-controls';
import { AdminPageHeader } from './shared/admin-page-header';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { AdminSelectField } from './shared/admin-select-field';
import { useAdminSession } from './use-admin-session';

const columns:readonly AdminDataColumn[]=[
  {id:'name',label:'账目',priority:'primary',minWidth:'17rem'},
  {id:'type',label:'类型',priority:'secondary',width:'8rem'},
  {id:'amount',label:'已出账金额',priority:'primary',width:'13rem',align:'right'},
  {id:'status',label:'出账状态',priority:'primary',width: ADMIN_TABLE_WIDTHS.status},
  {id:'created',label:'创建时间',priority:'secondary',width: ADMIN_TABLE_WIDTHS.dateTime},
  {id:'action',label:'操作',priority:'primary',width:'6rem'},
];
const kinds:Record<BillingEntry['kind'],string>={single:'单实例',range:'编排实例',platform_image:'镜像 / 快照',platform_bucket:'对象存储',resource:'独立资源',platform_import:'镜像上传'};
const uses:Record<string,string>={creating:'创建中',active:'使用中',partially_released:'部分回收',released:'已回收',failed:'任务失败',allocation_ended:'费用归属结束'};
const billStatuses=['','issued','partial','unissued','not_applicable','pending'] as const;
const validBillingRange=({startAt,endAt}:BillingRange)=>Boolean(parseLocalDate(startAt,false)&&parseLocalDate(endAt,false)&&startAt<=endAt);
const ResourceAlertsPanel = dynamic(() => import('./resource-alerts-screen').then(module => module.ResourceAlertsPanel), {
  loading: () => <Skeleton aria-label="正在加载资源告警" className="h-20 w-full" />,
});

function BillingRangeFilter({range,onChange}:{range:BillingRange;onChange:(range:BillingRange)=>void}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(range);
  const valid=validBillingRange(draft);
  const label=`${range.startAt} 至 ${range.endAt}`;
  const sameYear=range.startAt.slice(0,4)===range.endAt.slice(0,4);
  return <Popover open={open} onOpenChange={next=>{if(next)setDraft(range);setOpen(next);}}>
    <PopoverTrigger asChild>
      <Button type="button" size="sm" variant="outline" aria-label={`账期：${label}`} className="h-8 min-w-0 justify-start px-2 text-xs sm:px-3">
        <CalendarDays aria-hidden="true" className="hidden size-3.5 sm:block"/>
        <span className="hidden tabular-nums sm:inline">{label}</span>
        <span aria-hidden="true" className="min-w-0 truncate tabular-nums sm:hidden">{sameYear?`${range.startAt.slice(5)} 至 ${range.endAt.slice(5)}`:label}</span>
        <ChevronDown aria-hidden="true" className="ml-auto size-3"/>
      </Button>
    </PopoverTrigger>
    <PopoverContent aria-label="设置账期" className="w-80">
      <div className="grid grid-cols-2 gap-2">
        <div className="grid min-w-0 gap-1.5"><span className="text-xs text-muted-foreground">开始日期</span><DateTimePicker aria-label="开始账期" includeTime={false} required value={draft.startAt} onValueChange={value=>setDraft(previous=>({...previous,startAt:value}))}/></div>
        <div className="grid min-w-0 gap-1.5"><span className="text-xs text-muted-foreground">结束日期</span><DateTimePicker aria-label="结束账期" includeTime={false} required value={draft.endAt} onValueChange={value=>setDraft(previous=>({...previous,endAt:value}))}/></div>
      </div>
      {!valid?<p className="mt-2 text-xs text-destructive" role="alert">请选择完整账期，开始日期不能晚于结束日期。</p>:null}
      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" disabled={!valid} onClick={()=>{if(draft.startAt!==range.startAt||draft.endAt!==range.endAt)onChange(draft);setOpen(false);}}>应用账期</Button>
      </div>
    </PopoverContent>
  </Popover>;
}

export function BillingScreen({apiBaseUrl='http://localhost:3001'}:{apiBaseUrl?:string}) {
  const router=useRouter(),session=useAdminSession(),workspaceContext=useCloudWorkspace();
  const active=useAdminRouteIsActive('/admin/billing');
  const [alertsOpen,setAlertsOpen]=useState(false);
  const workspaceId=workspaceContext?.workspace?.id??readCloudWorkspaceSelection(session.profile?.id);
  const principalKey=JSON.stringify([session.profile?.id,session.profile?.role,session.profile?.isPlatformManager===true,workspaceContext?.workspace?.provider,workspaceContext?.workspace?.accountUid,billingSessionScope(session.token??'')]);
  const context=useMemo(()=>({apiBaseUrl,token:session.token??'',workspaceId,principalKey}),[apiBaseUrl,session.token,workspaceId,principalKey]);
  useEffect(()=>{setAlertsOpen(false);},[workspaceId,principalKey]);
  const onUnauthorized=useCallback(()=>{clearBillingReadCache();session.logout();router.replace('/admin/login');},[session.logout,router]);
  useEffect(()=>{if(!active||!session.isReady)return;if(!session.token)router.replace('/admin/login');else if(!session.isAdmin)router.replace('/admin/scenarios');},[active,session.isReady,session.token,session.isAdmin,router]);
  if(!session.isReady)return null;
  if(!session.token||!session.isAdmin)return <p className="admin-empty">{!session.token?'正在跳转到管理员登录页...':'当前账号无权访问账单费用。'}</p>;
  if(workspaceContext&&(!workspaceContext.isReady||workspaceContext.isSwitching||!workspaceContext.workspace))return <div className="admin-screen"><section className="admin-workbench-surface"><AdminPageHeader title="账单费用"/><Skeleton aria-label="正在确认云账号工作空间" className="mt-4 h-12 w-full"/></section></div>;
  const showAlerts=alertsOpen&&session.profile?.isPlatformManager===true;
  const resourceAction=session.profile?.isPlatformManager?<Button type="button" size="sm" variant="outline" onClick={()=>setAlertsOpen(true)}>资源告警</Button>:null;
  return <>
    <div style={{display:showAlerts?'none':'contents'}} hidden={showAlerts}>
      {workspaceContext?.workspace?.provider==='tencent_cloud'?<LegacyBillingScreen apiBaseUrl={apiBaseUrl} visible={active&&!showAlerts} resourceAction={resourceAction}/>
        :<BillingLifecycleScreen key={JSON.stringify([apiBaseUrl,principalKey,workspaceId])} context={context} active={active&&!showAlerts} readOnly={workspaceContext?.workspace?.isReadOnly===true} onUnauthorized={onUnauthorized} resourceAction={resourceAction}/>}
    </div>
    {showAlerts?<div className="admin-screen"><section className="admin-workbench-surface">
      <AdminPageHeader title="账单费用" action={<Button type="button" size="sm" variant="outline" onClick={()=>setAlertsOpen(false)}><ArrowLeft aria-hidden="true"/>返回费用明细</Button>}/>
      {active?<ResourceAlertsPanel apiBaseUrl={apiBaseUrl}/>:null}
    </section></div>:null}
  </>;
}

function BillingLifecycleScreen({context,active,readOnly,onUnauthorized,resourceAction}:{context:BillingRequestContext;active:boolean;readOnly:boolean;onUnauthorized:()=>void;resourceAction:ReactNode}) {
  const isCel = usePlatformTheme() === 'cel';
  const [range,setRange]=useState<BillingRange>(getDefaultRange),[view,setView]=useState<'user'|'platform'>('user');
  const [userId,setUserId]=useState(''),[billStatus,setBillStatus]=useState<BillingDocumentStatus|''>('');
  const [page,setPage]=useState(1),{pageSize,setPageSize}=useAdminPageSize();
  const [revision,setRevision]=useState(0),[snapshot,setSnapshot]=useState<{key:string;result:BillingEntriesResult}|null>(null);
  const [users,setUsers]=useState<AdminUser[]>([]),[usersError,setUsersError]=useState(false),[usersAttempt,setUsersAttempt]=useState(0);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[actionError,setActionError]=useState<string|null>(null);
  const [legacy,setLegacy]=useState(false),[exporting,setExporting]=useState(false);
  const [expanded,setExpanded]=useState<Set<string>>(new Set()),[selectedEntry,setSelectedEntry]=useState<BillingEntry|null>(null);
  const validRange=validBillingRange(range);
  const query=useMemo<BillingEntriesQuery>(()=>({...range,view,userId:view==='user'?userId||undefined:undefined,page,pageSize,groupBy:'batch',billStatus:billStatus||undefined}),[range,view,userId,page,pageSize,billStatus]);
  const queryKey=JSON.stringify([context,query]);
  const result=snapshot?.key===queryKey?snapshot.result:readCachedBillingEntries(context,query)??null;
  const latest=useRef({context,active,queryKey});latest.current={context,active,queryKey};
  const screen=useRef<HTMLDivElement>(null),mounted=useRef(false),previousRevision=useRef(revision);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!active)setSelectedEntry(null);},[active]);
  useEffect(()=>{setExporting(false);setActionError(null);},[context]);
  useEffect(()=>{
    if(!active||legacy)return;let current=true;setUsersError(false);
    fetchAdminUsers(context.apiBaseUrl,context.token,context.workspaceId).then(items=>{if(current)setUsers(items);}).catch(error=>{if(!current)return;if(isUnauthorizedAdminError(error))onUnauthorized();else setUsersError(true);});
    return()=>{current=false;};
  },[context,active,legacy,usersAttempt,onUnauthorized]);
  useEffect(()=>{
    if(!active)return;
    if(legacy||!validRange)return;
    let current=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=previousRevision.current!==revision;previousRevision.current=revision;
    const load=async(force:boolean)=>{
      setLoading(true);setLoadError(null);
      try{
        const next=await fetchBillingEntries(context,query,controller.signal,{refresh:force});if(!current)return;
        setSnapshot({key:queryKey,result:next});if(next.page!==page)setPage(next.page);
        if(!readOnly&&(next.queryStatus.queuedCount>0||next.queryStatus.runningCount>0))timer=setTimeout(()=>void load(true),15000);
      }catch(error){
        if(!current)return;
        if(isUnauthorizedAdminError(error))onUnauthorized();else if(error instanceof AdminApiError&&(error.status===404||error.status===501))setLegacy(true);
        else {if(error instanceof AdminApiError&&error.status===403){clearBillingReadCache();setSnapshot(null);}setLoadError(error instanceof AdminApiError&&error.status===403?'当前账号无权查看此工作空间的账单。':'账单加载失败，请稍后重试。');}
      }finally{if(current)setLoading(false);}
    };
    void load(refresh);return()=>{current=false;controller.abort();clearTimeout(timer);};
  },[context,active,readOnly,legacy,validRange,queryKey,revision,onUnauthorized]);
  const closeDetail=()=>{setSelectedEntry(null);setActionError(null);};
  const updateRange=(next:BillingRange)=>{closeDetail();setRange(next);setPage(1);setExpanded(new Set());};
  const refresh=()=>{clearBillingReadCache();setRevision(value=>value+1);};
  const exportCsv=async(kind:'platform'|'users'|'user')=>{
    if(!active||exporting||!validRange)return;const requestContext=context,requestKey=queryKey;
    const stillCurrent=()=>mounted.current&&latest.current.active&&latest.current.context===requestContext&&latest.current.queryKey===requestKey;
    setExporting(true);setActionError(null);
    try{const {apiBaseUrl,token,workspaceId}=requestContext;const csv=kind==='platform'?await exportPlatformBillingCsv(apiBaseUrl,token,range,workspaceId):kind==='user'&&userId?await exportBillingUserItemsCsv(apiBaseUrl,token,userId,range,workspaceId):await exportBillingUsersCsv(apiBaseUrl,token,range,workspaceId);if(stillCurrent())downloadCsv(csv,kind==='platform'?'platform-billing.csv':kind==='user'?`billing-user-${userId}.csv`:'billing-users.csv');}
    catch(error){if(!stillCurrent())return;if(isUnauthorizedAdminError(error))onUnauthorized();else setActionError('账单导出失败，请稍后重试。');}
    finally{if(mounted.current&&latest.current.context===requestContext)setExporting(false);}
  };
  const toggle=(id:string)=>setExpanded(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const counts=result?.billingStatusCounts;
  const syncLabel=readOnly?'历史账单':result?.mode==='shadow'?'自动核对试运行':result?.mode==='legacy'?'自动同步':'每日自动核对';
  const syncDescription=syncLabel+(result?.queryStatus.lastRunAt?`；最近核对：${formatAdminDateTime(result.queryStatus.lastRunAt)}`:'');
  const row=(entry:BillingEntry,visibleColumns:readonly AdminDataColumn[],child=false)=>{
    const batch=entry.rowType==='batch'&&Boolean(entry.members?.length);
    const isExpanded=batch&&expanded.has(entry.id);
    const activate=()=>batch?toggle(entry.id):setSelectedEntry(entry);
    const values:Record<string,ReactNode>={
      name:<div className={`grid min-w-0 gap-1 ${child?'pl-6':''}`}>
        <AdminDataTableText className="font-medium">{entry.name}</AdminDataTableText>
        <span className="truncate text-xs text-muted-foreground">{[entry.ownerUsername??(entry.ownerUserId?entry.ownerUserId:'平台公共'),batch?`${entry.members?.length} 个实例`:entry.sourceInstanceName??uses[entry.lifecycleStatus]].filter(Boolean).join(' · ')}</span>
      </div>,
      type:batch?entry.kind==='range'?'编排批次':'实例批次':kinds[entry.kind],
      status:<BillingDocumentBadge entry={entry}/>,
      amount:<span className={batch?'font-semibold':'font-medium'}><BillingAmounts amounts={entry.amounts}/></span>,
      created:<span className="text-xs text-muted-foreground">{formatAdminDateTime(entry.createdAt)}</span>,
      action:<Button variant="outline" size="sm" type="button" className="min-w-16 px-2 text-xs"
        aria-label={batch?`${isExpanded?'收起':'展开'}批次 ${entry.name}`:`查看 ${entry.name} 账单详情`}
        aria-expanded={batch?isExpanded:undefined} aria-haspopup={batch?undefined:'dialog'} onClick={activate}>
        {batch?isExpanded?'收起':'展开':'明细'}
        {batch?<ChevronDown aria-hidden="true" className={isExpanded?'size-3 rotate-180':'size-3'}/>:<ChevronRight aria-hidden="true" className="size-3"/>}
      </Button>,
    };
    return <TableRow key={entry.id} className={`cursor-pointer ${batch?'bg-muted/35':child?'bg-background':''}`}
      onClick={event=>{if(canActivateBillingRow(event))activate();}}>{visibleColumns.map(column=><AdminDataTableCell key={column.id} column={column}>{values[column.id]}</AdminDataTableCell>)}</TableRow>;
  };
  if(legacy)return <LegacyBillingScreen apiBaseUrl={context.apiBaseUrl} visible={active} resourceAction={resourceAction}/>;
  const billedTotal = <div className="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto">
          <span className="shrink-0 text-xs text-muted-foreground" title="仅统计当前筛选范围内已确认归属的官方费用">已出账合计</span>
          <strong className="min-w-0 max-w-72 text-sm font-semibold [overflow-wrap:anywhere] [&_span]:whitespace-normal"><BillingAmounts amounts={result?.filteredAmounts??[]}/></strong>
        </div>;
  const billingActions = <div className="flex shrink-0 items-center gap-1.5">
          {resourceAction}
          <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="px-2 sm:px-3" disabled={exporting||!validRange}><Download aria-hidden="true" className="hidden size-3.5 sm:block"/>{exporting?'正在导出':'导出账单'}<ChevronDown aria-hidden="true" className="size-3"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>void exportCsv('users')}>导出用户汇总</DropdownMenuItem><DropdownMenuItem disabled={!userId||view!=='user'} onSelect={()=>void exportCsv('user')}>导出当前用户明细</DropdownMenuItem><DropdownMenuItem onSelect={()=>void exportCsv('platform')}>导出平台费用</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <Button type="button" size="sm" variant="outline" className="px-2 sm:px-3" title={syncDescription} aria-description={syncDescription} disabled={loading||!validRange} onClick={refresh}><RefreshCw aria-hidden="true" className={loading?'hidden size-3.5 animate-spin sm:block':'hidden size-3.5 sm:block'}/>刷新</Button>
        </div>;
  const billingViews = <div data-cel-view-buttons="" aria-label="费用明细视图" role="group" className="inline-flex justify-self-start rounded-md bg-muted p-0.5">{(['user','platform'] as const).map(value=><Button key={value} type="button" variant="ghost" size="sm" aria-pressed={view===value} className={`rounded px-1.5 text-xs sm:px-3 ${view===value?'bg-background shadow-sm':'text-muted-foreground'}`} onClick={()=>{if(view!==value){closeDetail();setView(value);setPage(1);}}}>{value==='user'?'用户明细':'平台费用'}</Button>)}</div>;
  const billingFilters = <>
        <AdminSelectField ariaLabel="筛选用户" className="h-8 w-full min-w-0 sm:w-28" disabled={view==='platform'} emptyOptionLabel={view==='platform'?'平台公共':'全部用户'} options={users.map(user=>({label:user.username,value:user.id}))} value={view==='user'?userId:''} onValueChange={value=>{closeDetail();setUserId(value);setPage(1);}}/>
        <BillingRangeFilter range={range} onChange={updateRange}/>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="sm" variant={billStatus?'secondary':'outline'} aria-label={`出账状态：${billStatus?billingDocumentLabels[billStatus]:'全部状态'}`} className="h-8 min-w-0 justify-between text-xs">
            {billStatus?billingDocumentLabels[billStatus]:'全部状态'}<ChevronDown aria-hidden="true" className="size-3"/>
          </Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuRadioGroup value={billStatus}>{billStatuses.map(status=><DropdownMenuRadioItem key={status||'all'} value={status}
              onSelect={()=>{if(billStatus!==status){closeDetail();setBillStatus(status);setPage(1);}}}>
              <span>{status?billingDocumentLabels[status]:'全部状态'}</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{status?counts?.[status]??'—':result?.rowTotal??result?.total??'—'}</span>
            </DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {usersError?<Button variant="ghost" size="sm" type="button" className="col-span-full justify-self-start" onClick={()=>setUsersAttempt(value=>value+1)}>重试用户列表</Button>:null}
      </>;
  return <div ref={screen} className="admin-screen admin-pagination-screen relative" data-testid="billing-lifecycle-screen">
    <section className="admin-workbench-surface admin-pagination-surface">
      {isCel ? <>
        <AdminPageHeader artwork="billing" title="账单费用" description="查看当前账期的费用归属和出账状态。" action={billingActions}
          overview={{ metrics: [
            { label: '已出账', tone: 'green', value: counts?.issued ?? (result?.total === 0 ? 0 : null) },
            { label: '当前账目', tone: 'blue', value: result?.rowTotal ?? result?.total },
            { label: '待核对资源', tone: 'red', value: result?.pendingResourceCount },
          ] }} />
        <AdminWorkbenchControls title="账目清单" views={billingViews} actions={billedTotal} filters={billingFilters} />
      </> : <>
        <header className="flex shrink-0 flex-wrap items-center gap-2 pb-2 sm:gap-x-3">
          <h1 className="mr-auto font-heading text-lg font-semibold text-foreground">账单费用</h1>
          {billedTotal}{billingActions}
        </header>
        <div className="grid shrink-0 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-center gap-2 pb-2 sm:flex sm:flex-wrap" aria-label="账单筛选">
          {billingViews}{billingFilters}
        </div>
      </>}
      {loadError?<div className="mb-3 flex items-center justify-between gap-3 text-sm" role="alert"><span className="text-destructive">{loadError}{result?' 当前显示上次数据。':''}</span><Button variant="outline" size="sm" onClick={refresh}>重试加载</Button></div>:null}
      {actionError?<p className="mb-3 text-sm text-destructive" role="alert">{actionError}</p>:null}
      {result?.integrity&&result.integrity.unrepresentedRows>0?<p className="mb-3 text-sm text-destructive" role="alert">有 {result.integrity.unrepresentedRows} 条出账明细尚未关联账目。</p>:null}
      <AdminPaginatedList footer={result&&result.total>0?<AdminPaginationControls label="账目分页" pagination={getPagination(result.total,page,pageSize)} pageSize={pageSize} isPending={loading} onPageSelect={value=>{closeDetail();setPage(value);}} onPageSizeChange={value=>{closeDetail();setPageSize(value);setPage(1);}}/>:null}>
        <AdminDataTable label="实例与平台资产账目" columns={columns} isRefreshing={loading&&Boolean(result)}>{visibleColumns=><>
          {!result&&loading&&validRange?Array.from({length:6},(_,i)=><TableRow key={i}><TableCell colSpan={visibleColumns.length}><Skeleton className="my-1 h-10 w-full" aria-label={i===0?'正在加载账目':undefined}/></TableCell></TableRow>):null}
          {result?.items.map(entry=><Fragment key={entry.id}>{row(entry,visibleColumns)}{entry.rowType==='batch'&&expanded.has(entry.id)?entry.members?.map(member=>row(member,visibleColumns,true)):null}</Fragment>)}
          {result?.total===0?<TableRow><TableCell colSpan={visibleColumns.length}><p className="py-12 text-center text-sm text-muted-foreground">{billStatus?'当前筛选没有账目。':'当前账期没有账目。'}</p></TableCell></TableRow>:null}
        </>}</AdminDataTable>
      </AdminPaginatedList>
    </section>
    {selectedEntry&&active?<BillingEntryDetails key={JSON.stringify([context.apiBaseUrl,context.workspaceId,context.principalKey,selectedEntry.id])} context={context} entry={selectedEntry} range={range} revision={revision} container={screen.current} onOpenChange={open=>{if(!open)setSelectedEntry(null);}} onUnauthorized={onUnauthorized}/>:null}
  </div>;
}
