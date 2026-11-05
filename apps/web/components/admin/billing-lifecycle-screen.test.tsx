import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingCharge, BillingEntriesResult, BillingEntry, BillingEntryDetail, BillingResource } from '../../lib/billing-lifecycle-api';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(), logout: vi.fn(), workspaceId: 'workspace-a', isAdmin: true, identity: 'admin', token: 'fixture-token',
  billingSync: true, switching: false, active: true, readOnly: false, isPlatformManager: false,
}));
const router = { replace: mocks.replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ token: mocks.token, profile: { id: mocks.identity, username: mocks.identity, role: mocks.isAdmin ? 'admin' : 'user', isPlatformManager: mocks.isPlatformManager }, isReady: true, isAdmin: mocks.isAdmin, logout: mocks.logout }) }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => ({ workspace: { id: mocks.workspaceId, isReadOnly: mocks.readOnly, capabilities: { billingSync: mocks.billingSync } }, isReady: true, isSwitching: mocks.switching }) }));
vi.mock('./admin-page-cache', () => ({ useAdminRouteIsActive: () => mocks.active }));
import { BillingScreen } from './billing-screen';
import { clearBillingReadCache } from '../../lib/billing-lifecycle-api';

const when = '2026-10-12T10:00:00.000Z';
const entry = (overrides: Partial<BillingEntry> = {}): BillingEntry => ({
  id: 'single:one', kind: 'single', name: '无账单靶机', ownerUserId: 'alice', ownerUsername: 'alice', batch: { id: 'batch', name: '演练批次' },
  createdAt: when, instanceStatus: 'running', plannedExpiresAt: '2026-10-30T10:00:00.000Z', releaseConfirmedAt: null,
  lifecycleStatus: 'active', reconciliationStatus: 'waiting', amounts: [], resourceCount: 1, pendingResourceCount: 1,
  lastQueriedAt: null, lastVerifiedAt: null, coveredThrough: null, ...overrides,
});
const resource = (overrides: Partial<BillingResource> = {}): BillingResource => ({
  ledgerId: 'ledger-one', cloudResourceId: 'snap-one', cloudResourceType: 'snapshot', cloudProvider: 'alibaba_cloud', regionId: 'cn-hangzhou',
  billingStartAt: when, releasedAt: null, state: 'no_bill', amounts: [], coveredThrough: null, lastQueriedAt: when,
  lastVerifiedAt: null, reasonCode: null, reasonMessage: null, nextQueryAt: when, parentBillingResourceId: null, ...overrides,
});
const entries = (items = [entry()], overrides: Partial<BillingEntriesResult> = {}): BillingEntriesResult => ({
  version: 2, startAt: '2026-10-01', endAt: '2026-10-28', mode: 'resource', items, page: 1, pageSize: 20, total: items.length,
  currencyTotals: [], pendingResourceCount: items.length,
  queryStatus: { lastRunAt: null, nextRunAt: null, queuedCount: 0, runningCount: 0, errorCount: 0 }, ...overrides,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const fetchMock = vi.fn<typeof fetch>();
const calls = (path: string) => fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === path);
function routeList(handler: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/admin/users') return json([
      { id: 'alice', username: 'alice' }, { id: 'bob', username: 'bob（尚无账单）' },
    ]);
    return handler(url, init);
  });
}
function row(name: string) { return screen.getByRole('button', { name: `查看 ${name} 账单详情` }).closest('tr')!; }
async function chooseUser(name: string) {
  fireEvent.click(screen.getByRole('combobox', { name: '筛选用户' }));
  fireEvent.click(await screen.findByRole('option', { name }));
}
async function openExport(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: '导出账单' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

beforeEach(() => {
  Object.assign(mocks, { workspaceId: 'workspace-a', isAdmin: true, identity: 'admin', token: 'fixture-token', billingSync: true, switching: false, active: true, readOnly: false, isPlatformManager: false });
  mocks.replace.mockReset(); mocks.logout.mockReset(); fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { clearBillingReadCache(); cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('lifecycle billing interactions', () => {
  it('loads resource alerts only on request and preserves the current billing filters on return', async () => {
    mocks.isPlatformManager = true;
    routeList(url => url.pathname === '/admin/resource-alerts' ? json([])
      : url.pathname === '/admin/resource-alerts/patrol' ? json({ status: 'ready', managerUserId: 'admin', managerUsername: 'admin', accountUid: '123456', lastCompleted: true, lastScanAt: when })
      : json(entries()));
    render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    await chooseUser('bob（尚无账单）');
    await waitFor(() => expect(calls('/admin/billing/entries').at(-1)?.[0].toString()).toContain('userId=bob'));
    expect(calls('/admin/resource-alerts')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '资源告警' }));
    expect(await screen.findByRole('table', { name: '资源告警列表' })).toBeTruthy();
    expect(calls('/admin/resource-alerts')).toHaveLength(1);
    expect(screen.queryByRole('table', { name: '实例与平台资产账目' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回费用明细' }));
    await screen.findByRole('table', { name: '实例与平台资产账目' });
    expect(screen.getByRole('combobox', { name: '筛选用户' }).textContent).toContain('bob（尚无账单）');
  });

  it('shows ECS specs in the overview and lists zero fees and refunds directly in the expanded details', async () => {
    const charges:BillingCharge[]=[
      {id:'cpu',resourceId:'i-shared',resourceType:'ecs',name:'云服务器配置',category:'ecs',status:'issued',amounts:[{currency:'CNY',pretaxAmount:0.13}],usage:null,usageUnit:null,billingFrom:'2026-10-12',billingTo:'2026-10-12',transactionType:null,message:null,rowCount:1},
      {id:'os',resourceId:'i-shared',resourceType:'ecs',name:'ImageOS',category:'ecs',status:'issued',amounts:[{currency:'CNY',pretaxAmount:0}],usage:null,usageUnit:null,billingFrom:'2026-10-12',billingTo:'2026-10-12',transactionType:null,message:null,rowCount:1},
      {id:'refund',resourceId:'i-shared',resourceType:'ecs',name:'流量退款',category:'network_usage',status:'issued',amounts:[{currency:'USD',pretaxAmount:-0.05}],usage:'0.125',usageUnit:'GB',billingFrom:'2026-10-12',billingTo:'2026-10-12',transactionType:'Refund',message:null,rowCount:1},
    ];
    routeList(url=>json(url.pathname==='/admin/billing/entries'?entries():{entry:entry(),resources:[],events:[],charges,
      resourceFees:[{resourceId:'i-shared',resourceType:'ecs',amounts:[{currency:'CNY',pretaxAmount:0.13},{currency:'USD',pretaxAmount:-0.05}],
        specification:{cpu:2,memory:'2 GB',systemDisk:'40 GiB',instanceType:'ecs.e-c1m1.large',os:'Linux'}}]}));
    render(<BillingScreen/>);
    await screen.findByRole('button',{name:'查看 无账单靶机 账单详情'});
    fireEvent.click(within(row('无账单靶机')).getByText('单实例'));
    const resources=within(await screen.findByRole('list',{name:'计费资源'}));
    expect(resources.getByText('2 核 · 2 GB · 系统盘 40 GiB')).toBeTruthy();
    expect(resources.getByText('-USD 0.05')).toBeTruthy();
    expect(resources.queryByText('¥ 0.00')).toBeNull();
    fireEvent.click(resources.getByText('2 核 · 2 GB · 系统盘 40 GiB'));
    const basis=within(resources.getByRole('region',{name:'计费依据'}));
    expect(basis.getByText('i-shared')).toBeTruthy();
    expect(basis.getByText('ecs.e-c1m1.large')).toBeTruthy();
    expect(basis.getByText('2026-10-12')).toBeTruthy();
    const fees=within(resources.getByRole('region',{name:'费用组成'}));
    expect(fees.getByText('实例费')).toBeTruthy();
    expect(fees.getByText('镜像费')).toBeTruthy();
    expect(fees.getByText('¥ 0.00')).toBeTruthy();
    expect(fees.getByText('流量退款')).toBeTruthy();
    expect(fees.getByText('-USD 0.05')).toBeTruthy();
    expect(fees.getByText('用量：0.125 GB')).toBeTruthy();
    expect(resources.queryByText(/Linux|零元费用/)).toBeNull();
    fireEvent.click(resources.getByRole('button',{name:'收起 i-shared 计费详情'}));
    expect(resources.queryByText('¥ 0.00')).toBeNull();
  });
  it('retains different component periods and unknown network fees inside one resource group', async () => {
    const base:BillingCharge={id:'one',resourceId:'i-periods',resourceType:'ecs',name:'配置费',category:'ecs',status:'issued',amounts:[{currency:'CNY',pretaxAmount:1}],usage:null,usageUnit:null,billingFrom:'2026-10-11',billingTo:'2026-10-11',transactionType:null,message:null,rowCount:1};
    const charges=[base,{...base,id:'two',name:'带宽费',billingFrom:'2026-10-12',billingTo:'2026-10-13'},
      {...base,id:'unknown',name:'公网流量',category:'network_usage',status:'not_returned' as const,amounts:[],billingFrom:null,billingTo:null,message:'尚未取得官方网络费用明细'}];
    routeList(url=>json(url.pathname==='/admin/billing/entries'?entries():{entry:entry(),resources:[],events:[],charges}));
    render(<BillingScreen/>);
    fireEvent.click(await screen.findByRole('button',{name:'查看 无账单靶机 账单详情'}));
    const resources=within(await screen.findByRole('list',{name:'计费资源'}));
    expect(resources.getByText('部分出账')).toBeTruthy();
    fireEvent.click(resources.getByRole('button',{name:'展开 i-periods 计费详情'}));
    const fees=within(resources.getByRole('region',{name:'费用组成'}));
    expect(fees.getByText('账期：2026-10-11')).toBeTruthy();expect(fees.getByText('账期：2026-10-12 — 2026-10-13')).toBeTruthy();
    expect(fees.getByText('尚未取得官方网络费用明细')).toBeTruthy();
    expect(fees.getByText('暂无明细')).toBeTruthy();expect(fees.queryByText('¥ 0.00')).toBeNull();
  });
  it('shows invoices in the main list and uses the current filtered amount without a separate pending panel', async () => {
    routeList(() => json(entries([entry({ name: 'failed source', instanceStatus: 'create_failed', lifecycleStatus: 'failed', resourceCount: 0,
      pendingResourceCount: 0, reconciliationStatus: 'source_pending', issueMessage: '计费资源记录待核验' })], {
      filteredAmounts: [{ currency: 'CNY', pretaxAmount: 5.75 }],
      currencyTotals: [{ currency: 'CNY', pretaxAmount: 745, userPretaxAmount: 700, platformPretaxAmount: 45 }],
      rowTotal:1,billingStatusCounts:{issued:0,partial:0,unissued:0,pending:1,not_applicable:0},
      queryStatus: { lastRunAt: when, nextRunAt: when, queuedCount: 8000, runningCount: 1, errorCount: 12, errorResourceCount: 2 },
    })));
    render(<BillingScreen />);
    await screen.findByRole('button',{name:'查看 failed source 账单详情'});
    expect(screen.getByText('已出账合计').parentElement?.textContent).toContain('¥ 5.75');
    expect(row('failed source').textContent).toContain('待核验');
    expect(screen.queryByText('待核对账目')).toBeNull();
    expect(document.body.textContent).not.toContain('8000');
  });
  it('separates failed attempts with no billable resources from pending verification and waiting bills', async () => {
    const failed=entry({id:'before-create',name:'镜像校验失败',instanceStatus:'create_failed',lifecycleStatus:'failed',resourceCount:0,pendingResourceCount:0,
      reconciliationStatus:'current',billingStatus:'not_applicable',billingNotRequired:true,issueMessage:'未创建计费资源'});
    const unknown=entry({id:'unknown',name:'历史创建待核验',instanceStatus:'destroyed',lifecycleStatus:'released',resourceCount:0,
      reconciliationStatus:'source_pending',billingStatus:'pending'});
    routeList(url=>json(url.pathname==='/admin/billing/entries'?entries([failed,unknown],{rowTotal:2,billingStatusCounts:{issued:0,partial:0,unissued:0,not_applicable:1,pending:1}})
      : {entry:failed,resources:[],events:[{id:'failed',type:'create',title:'创建实例',status:'failed',at:when}],charges:[]}));
    render(<BillingScreen/>);
    await screen.findByRole('button',{name:'查看 镜像校验失败 账单详情'});
    expect(row('镜像校验失败').textContent).toContain('无需出账');
    expect(row('镜像校验失败').textContent).not.toContain('0.00');
    expect(row('历史创建待核验').textContent).toContain('待核验');
    expect(row('历史创建待核验').textContent).toContain('已回收');
    fireEvent.keyDown(screen.getByRole('button',{name:'出账状态：全部状态'}),{key:'Enter'});
    fireEvent.click(await screen.findByRole('menuitemradio',{name:'无需出账 1'}));
    await waitFor(()=>expect(calls('/admin/billing/entries').at(-1)?.[0].toString()).toContain('billStatus=not_applicable'));
    await screen.findByRole('button',{name:'查看 镜像校验失败 账单详情'});
    fireEvent.keyDown(screen.getByRole('button',{name:'出账状态：无需出账'}),{key:'Enter'});
    expect((await screen.findByRole('menuitemradio',{name:'无需出账 1'})).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio',{name:'待核验 1'}));
    await waitFor(()=>expect(calls('/admin/billing/entries').at(-1)?.[0].toString()).toContain('billStatus=pending'));
    fireEvent.click(screen.getByRole('button',{name:'查看 镜像校验失败 账单详情'}));
    expect(await screen.findByText('未产生计费资源，无需等待出账。')).toBeTruthy();
  });
  it('shows all significant decimals when an aggregate does not fit a Number', async () => {
    const exact = '99999999998.999999999999999999';
    routeList(() => json(entries([entry({ amounts: [{ currency: 'CNY', pretaxAmount: 99999999999, pretaxAmountExact: exact }] })])));
    render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    expect(row('无账单靶机').textContent).toContain('99,999,999,998.999999999999999999');
  });
  it('keeps batch totals and issued/unissued members in the same table', async () => {
    const zero=entry({id:'zero',name:'官方零元',reconciliationStatus:'current',amounts:[{currency:'CNY',pretaxAmount:0}],billingStatus:'issued'});
    const failed=entry({id:'failed',name:'创建失败',reconciliationStatus:'source_pending',amounts:[],resourceCount:0,billingStatus:'unissued'});
    const parent=entry({id:'batch:one',name:'mixed batch',rowType:'batch',members:[zero,failed],billingStatus:'partial',amounts:[{currency:'CNY',pretaxAmount:0}]});
    routeList(() => json(entries([parent],{rowTotal:1,billingStatusCounts:{issued:0,partial:1,unissued:0}})));
    render(<BillingScreen />);
    await screen.findByRole('button',{name:'展开批次 mixed batch'});
    fireEvent.click(screen.getByText('mixed batch'));
    expect(row('官方零元').textContent).toContain('已出账');expect(row('官方零元').textContent).toContain('¥ 0.00');
    expect(row('创建失败').textContent).toContain('未出账');expect(row('创建失败').textContent).not.toContain('0.00');
    expect(screen.queryByText(/批次费用汇总/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'收起批次 mixed batch'}));
    expect(screen.queryByText('官方零元')).toBeNull();
  });
  it('labels archived spaces as historical and does not poll a queue that cannot run', async () => {
    mocks.readOnly = true;
    routeList(() => json(entries([entry()], { queryStatus: { lastRunAt: when, nextRunAt: when, queuedCount: 1, runningCount: 0, errorCount: 0 } })));
    vi.useFakeTimers();
    await act(async () => { render(<BillingScreen />); });
    expect(screen.getByRole('button',{name:'刷新'}).getAttribute('aria-description')).toContain('历史账单');
    expect(screen.queryByText('每日自动核对')).toBeNull();
    expect(screen.queryByText('后台核对中')).toBeNull();
    const count = calls('/admin/billing/entries').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(calls('/admin/billing/entries')).toHaveLength(count);
  });
  it('keeps an explicit warning when a booked line is not represented in the list', async () => {
    routeList(() => json(entries([entry()], { integrity: { bookedRows: 4, representedRows: 3, unrepresentedRows: 1 } })));
    render(<BillingScreen />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '有 1 条出账明细尚未关联账目。');
  });
  it('lists assets before bills and distinguishes unknown, official zero, refunds and currencies', async () => {
    routeList(() => json(entries([
      entry(), entry({ id: 'zero', name: '官方零元', reconciliationStatus: 'current', amounts: [{ currency: 'CNY', pretaxAmount: 0 }] }),
      entry({ id: 'refund', name: '退款记录', amounts: [{ currency: 'USD', pretaxAmount: -0.1325781504 }, { currency: 'CNY', pretaxAmount: 1.25 }] }),
    ], { currencyTotals: [{ currency: 'CNY', pretaxAmount: 1.25, userPretaxAmount: 1.25, platformPretaxAmount: 0 }] })));
    render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    expect(row('无账单靶机').textContent).toContain('未出账');
    expect(row('无账单靶机').textContent).not.toContain('0.00');
    expect(row('官方零元').textContent).toContain('¥ 0.00');
    expect(row('退款记录').textContent).toContain('0.1325781504');
    expect(row('退款记录').textContent).toContain('USD');
    expect(row('无账单靶机').textContent).toContain('alice');
    const [url, init] = calls('/admin/billing/entries')[0]!;
    expect(new URL(String(url)).searchParams.get('view')).toBe('user');
    expect(new URL(String(url)).searchParams.has('userId')).toBe(false);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
    expect(new Headers(init?.headers).get('x-cloud-workspace-id')).toBe('workspace-a');
    expect(calls('/admin/billing/user-groups')).toHaveLength(0);
    expect(calls('/admin/billing/summary')).toHaveLength(0);
    expect(screen.queryByText(/结清/)).toBeNull();
  });

  it('lazily opens resource evidence and lifecycle events without creating extra expense rows', async () => {
    const main = entry({ lifecycleStatus: 'partially_released', instanceStatus: 'destroyed', reconciliationStatus: 'partial', releaseConfirmedAt: when });
    const detail: BillingEntryDetail = { entry: main, resources: [resource(), resource({ ledgerId: 'failed', cloudResourceId: 'eip-failed', cloudResourceType: 'eip', state: 'query_error', reasonMessage: '官方查询暂时不可用' }),
      resource({ ledgerId: 'source', cloudResourceId: 'source-missing', state: 'source_pending' }),
      resource({ ledgerId: 'disk', cloudResourceId: 'disk-one', cloudResourceType: 'disk', state: 'covered_by_parent', parentBillingResourceId: 'i-one' }),
      resource({ ledgerId: 'zero', cloudResourceId: 'i-zero', cloudResourceType: 'ecs', state: 'issued', amounts: [{ currency: 'CNY', pretaxAmount: 0 }], lastVerifiedAt: when, coveredThrough: when, releasedAt: when })],
      events: ['创建实例', '改期', '停止', '启动', '更新规则', '销毁实例'].map((title, index) => ({ id: String(index), title, type: title, status: 'succeeded', at: when, ...(title === '改期' ? { previousExpiresAt: when, requestedExpiresAt: '2026-10-30T10:00:00.000Z', effectiveExpiresAt: '2026-10-30T10:00:00.000Z' } : {}) })) };
    routeList(url => json(url.pathname === '/admin/billing/entries' ? entries([main]) : detail));
    render(<BillingScreen />);
    const button = await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    expect(calls('/admin/billing/entries/single%3Aone')).toHaveLength(0);
    fireEvent.click(button);
    fireEvent.keyDown(await screen.findByRole('tab',{name:'关联资源'}),{key:'Enter'});
    const resources = await screen.findByRole('list', { name: '关联计费资源' });
    expect(resources.textContent).toContain('未出账');
    expect(resources.textContent).toContain('官方查询暂时不可用');
    expect(resources.textContent).toContain('待确认');
    expect(resources.textContent).toContain('¥ 0.00');
    expect(resources.textContent).toContain('已包含在关联费用内');
    expect(within(resources).getByText(/^\d{2}:\d{2}:\d{2} 至 \d{2}:\d{2}:\d{2}$/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab',{name:'操作记录'}),{key:'Enter'});
    const history = screen.getByRole('list', { name: '操作轨迹' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(6);
    expect(history.textContent).toContain('回收时间');
    expect(history.textContent).not.toContain('¥');
    expect(screen.getByText('实际回收')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /查看 .* 账单详情/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'关闭账单详情'}));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters users with no bills, changes views, validates dates and uses server pagination', async () => {
    routeList(url => json(entries([entry({ name: `第${url.searchParams.get('page')}页` })], {
      page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')) as 20, total: 101,
    })));
    render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 第1页 账单详情' });
    await chooseUser('bob（尚无账单）');
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('userId')).toBe('bob'));
    fireEvent.click(screen.getByRole('link', { name: '第 2 页' }));
    await screen.findByRole('button', { name: '查看 第2页 账单详情' });
    fireEvent.click(screen.getByRole('combobox', { name: '每页条数' }));
    fireEvent.click(screen.getByRole('option', { name: '50 条' }));
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('pageSize')).toBe('50'));
    expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('page')).toBe('1');
    await screen.findByRole('button', { name: '查看 第1页 账单详情' });
    fireEvent.click(screen.getByRole('combobox', { name: '每页条数' }));
    fireEvent.click(screen.getByRole('option', { name: '100 条' }));
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('pageSize')).toBe('100'));
    fireEvent.click(screen.getByRole('button', { name: '平台费用' }));
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('view')).toBe('platform'));
    expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.has('userId')).toBe(false);
    expect(screen.getByRole('combobox', { name: '筛选用户' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:/^账期：/}));
    fireEvent.change(await screen.findByLabelText('开始账期'), { target: { value: '' } });
    const count = calls('/admin/billing/entries').length;
    expect(screen.getByRole('button', { name: '应用账期' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('开始账期'), { target: { value: '2026-02-30' } });
    await act(async () => {});
    expect(calls('/admin/billing/entries')).toHaveLength(count);
    fireEvent.change(screen.getByLabelText('开始账期'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('结束账期'), { target: { value: '2026-09-30' } });
    expect(calls('/admin/billing/entries')).toHaveLength(count);
    fireEvent.click(screen.getByRole('button',{name:'应用账期'}));
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('endAt')).toBe('2026-09-30'));
    expect(calls('/admin/billing/entries')).toHaveLength(count+1);
  });

  it('ignores late list responses from older users and older pages', async () => {
    const old = deferred<Response>();
    routeList(url => !url.searchParams.has('userId') ? old.promise : json(entries([entry({ name: 'bob当前账目' })], { total: 40 })));
    render(<BillingScreen />);
    await chooseUser('bob（尚无账单）');
    await screen.findByRole('button', { name: '查看 bob当前账目 账单详情' });
    await act(async () => old.resolve(json(entries([entry({ name: 'alice迟到响应' })]))));
    expect(screen.queryByText('alice迟到响应')).toBeNull();
    const oldPage = deferred<Response>();
    routeList(url => url.searchParams.get('page') === '2' ? oldPage.promise : json(entries([entry({ name: '第1页最新' })], { total: 40 })));
    fireEvent.click(screen.getByRole('link', { name: '第 2 页' }));
    await waitFor(() => expect(new URL(String(calls('/admin/billing/entries').at(-1)![0])).searchParams.get('page')).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: '平台费用' }));
    await screen.findByRole('button', { name: '查看 第1页最新 账单详情' });
    await act(async () => oldPage.resolve(json(entries([entry({ name: '旧第2页' })], { page: 2, total: 40 }))));
    expect(screen.queryByText('旧第2页')).toBeNull();
  });

  it.each(['workspace', 'identity'])('isolates stale list and resource-detail responses after a %s change', async boundary => {
    const oldList = deferred<Response>();
    const oldDetail = deferred<Response>();
    let phase = 'initial';
    routeList(url => {
      if (url.pathname !== '/admin/billing/entries') return oldDetail.promise;
      if (phase === 'refresh') return oldList.promise;
      return json(entries([entry({ name: phase === 'next' ? '新空间账目' : '旧空间账目' })]));
    });
    const { rerender } = render(<BillingScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '查看 旧空间账目 账单详情' }));
    phase = 'refresh';
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    phase = 'next';
    if (boundary === 'workspace') mocks.workspaceId = 'workspace-b'; else mocks.identity = 'another-admin';
    rerender(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 新空间账目 账单详情' });
    await act(async () => { oldList.resolve(json(entries([entry({ name: '旧账目迟到' })]))); oldDetail.resolve(json({ entry: entry(), resources: [resource({ cloudResourceId: '旧空间资源' })], events: [] })); });
    expect(screen.queryByText('旧账目迟到')).toBeNull(); expect(screen.queryByText('旧空间资源')).toBeNull();
    expect(screen.queryByRole('list', { name: '关联计费资源' })).toBeNull();
    if (boundary === 'workspace') expect(new Headers(calls('/admin/billing/entries').at(-1)![1]?.headers).get('x-cloud-workspace-id')).toBe('workspace-b');
  });

  it('shows automatic daily reconciliation and follows progress without submitting any write', async () => {
    let queue = 2;
    routeList((url, init) => {
      if (init?.method === 'POST') throw new Error('Billing page must not start reconciliation');
      return json(entries([entry()], { queryStatus: { lastRunAt: when, nextRunAt: when, queuedCount: queue, runningCount: 0, errorCount: 0 } }));
    });
    vi.useFakeTimers();
    await act(async () => { render(<BillingScreen />); });
    expect(screen.getByRole('button',{name:'刷新'}).getAttribute('aria-description')).toContain('每日自动核对');
    expect(screen.queryByText('待核对账目')).toBeNull();
    expect(screen.queryByRole('button', { name: '请求后台核对' })).toBeNull();
    expect(screen.queryByRole('button', { name: '核对 无账单靶机' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    const before = calls('/admin/billing/entries').length;
    queue = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(calls('/admin/billing/entries').length).toBeGreaterThan(before);
    expect(screen.getByRole('button',{name:'刷新'}).getAttribute('aria-description')).toContain('每日自动核对');
    expect(calls('/admin/billing/reconcile')).toHaveLength(0);
  });

  it.each(['workspace', 'filter'])('does not start new billing work after a %s change', async boundary => {
    routeList(() => json(entries()));
    const { rerender } = render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    if (boundary === 'workspace') { mocks.workspaceId = 'workspace-b'; rerender(<BillingScreen />); }
    else await chooseUser('bob（尚无账单）');
    await waitFor(() => expect(calls('/admin/billing/entries').length).toBeGreaterThan(1));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('preserves the CSV endpoints and suppresses an old workspace download', async () => {
    const csv = deferred<Response>();
    routeList(url => url.pathname.includes('/export/') ? csv.promise : json(entries()));
    const { rerender } = render(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    await chooseUser('bob（尚无账单）');
    await openExport('导出当前用户明细');
    expect(calls('/admin/billing/export/users/bob.csv')).toHaveLength(1);
    expect(new Headers(calls('/admin/billing/export/users/bob.csv')[0]![1]?.headers).get('x-cloud-workspace-id')).toBe('workspace-a');
    mocks.workspaceId = 'workspace-b'; rerender(<BillingScreen />);
    await act(async () => csv.resolve(new Response('fixture csv')));
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    routeList(url => url.pathname.includes('/export/') ? new Response('new csv') : json(entries()));
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    await openExport('导出平台费用');
    await waitFor(() => expect(window.URL.createObjectURL).toHaveBeenCalledOnce());
    await openExport('导出用户汇总');
    await waitFor(() => expect(calls('/admin/billing/export/users.csv')).toHaveLength(1));
    expect(calls('/admin/billing/export/platform.csv')).toHaveLength(1);
  });

  it.each([404, 501])('uses the real legacy component only when entries returns %s', async status => {
    routeList(url => {
      if (url.pathname === '/admin/billing/entries') return json({}, status);
      if (url.pathname === '/admin/billing/summary') return json({ billingScope: 'platform_resources', totalPretaxAmount: 0, platformPretaxAmount: 0, reconciliationIssues: [] });
      return json({ items: [], page: 1, pageSize: 20, total: 0 });
    });
    render(<BillingScreen />);
    await screen.findByText('当前账期没有费用明细');
    expect(calls('/admin/billing/user-groups').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: '实例与平台资产账目' })).toBeNull();
  });

  it.each([403, 500, 'network'])('exposes %s errors and never masks them with the legacy API', async failure => {
    routeList(() => { if (failure === 'network') throw new TypeError('private network diagnostics'); return json({}, Number(failure)); });
    render(<BillingScreen />);
    await screen.findByText(failure === 403 ? '当前账号无权查看此工作空间的账单。' : '账单加载失败，请稍后重试。');
    expect(calls('/admin/billing/summary')).toHaveLength(0);
    expect(screen.queryByText('private network diagnostics')).toBeNull();
    routeList(() => json(entries()));
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
  });

  it('does not fall back for a missing detail, and lets that detail retry', async () => {
    let retry = false;
    routeList(url => url.pathname === '/admin/billing/entries' ? json(entries()) : retry ? json({ entry: entry(), resources: [resource()], events: [] }) : json({}, 404));
    render(<BillingScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' }));
    await screen.findByText('详情加载失败。');
    expect(calls('/admin/billing/summary')).toHaveLength(0);
    retry = true;
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    await screen.findByRole('tab',{name:'费用明细'});
  });

  it('explains shadow mode without exposing technical storage details', async () => {
    routeList(() => json(entries([entry()], { mode: 'shadow' })));
    render(<BillingScreen />);
    await waitFor(()=>expect(screen.getByRole('button',{name:'刷新'}).getAttribute('aria-description')).toContain('自动核对试运行'));
    expect(document.body.textContent).not.toMatch(/数据库|shadow|ledger/i);
  });

  it('keeps administrator and workspace capability checks', async () => {
    routeList(() => json(entries()));
    mocks.isAdmin = false;
    const { rerender } = render(<BillingScreen />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin/scenarios'));
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isAdmin = true; mocks.switching = true;
    rerender(<BillingScreen />);
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.switching = false; mocks.billingSync = false;
    rerender(<BillingScreen />);
    await screen.findByRole('button', { name: '查看 无账单靶机 账单详情' });
    expect(screen.queryByRole('button', { name: '请求后台核对' })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('redirects on 401 without invoking the legacy API', async () => {
    routeList(() => json({}, 401));
    render(<BillingScreen />);
    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith('/admin/login');
    expect(calls('/admin/billing/summary')).toHaveLength(0);
  });
});
