'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react';

import {
  exportBillingUserItemsCsv,
  exportBillingUsersCsv,
  exportPlatformBillingCsv,
  fetchBillingSummary,
  fetchBillingUserGroups,
  fetchBillingUsers,
  fetchPlatformBillingGroups,
  triggerBillingSync,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { BillingLaunchGroup, BillingSummary, BillingUserSummary } from '../../lib/admin-types';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Skeleton } from '../ui/skeleton';
import { AdminSelectField } from './shared/admin-select-field';
import { AdminPageHeader } from './shared/admin-page-header';
import { StatusBadge } from './shared/status-badge';
import { useAdminSession } from './use-admin-session';

type BillingScreenProps = {
  apiBaseUrl?: string;
};

type BillingRange = {
  startAt: string;
  endAt: string;
};

type DetailView = 'users' | 'platform';
type BillingExportKind = 'platform' | 'users' | 'user';

const preciseMoneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 9,
});

function getDefaultRange(): BillingRange {
  const endAt = new Date();
  const startAt = new Date(endAt);
  startAt.setDate(startAt.getDate() - 29);

  return {
    startAt: startAt.toISOString().slice(0, 10),
    endAt: endAt.toISOString().slice(0, 10),
  };
}

function formatMoney(value: number, currency = 'CNY') {
  const amount = Number.isFinite(value) ? value : 0;

  if (currency === 'CNY') {
    return `¥ ${preciseMoneyFormatter.format(amount)}`;
  }

  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 9,
    }).format(amount);
  } catch {
    return `${currency} ${preciseMoneyFormatter.format(amount)}`;
  }
}

function formatResourceType(resourceType: string) {
  switch (resourceType) {
    case 'ecs':
      return 'ECS 实例';
    case 'disk':
      return '系统盘 / 数据盘';
    case 'eip':
      return '弹性公网 IP';
    case 'nat_gateway':
      return 'NAT 网关';
    case 'snat_entry':
      return 'SNAT 条目';
    case 'dnat_entry':
      return 'DNAT 条目';
    case 'image':
      return '自定义镜像';
    case 'snapshot':
      return '快照';
    case 'snapshot_region':
      return '快照链容量';
    default:
      return resourceType;
  }
}

function formatBillingLineSecondary(item: BillingLaunchGroup['items'][number]) {
  return item.productDetail?.trim() || item.productCode || '账单项';
}

function formatBillingGroupTitle(group: Pick<BillingLaunchGroup, 'kind' | 'title'>) {
  if (group.kind === 'single_launch') {
    return '单实例';
  }

  if (group.kind === 'range_launch') {
    return '编排实例';
  }

  return group.title;
}

function downloadCsv(contents: string, fileName: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.URL.revokeObjectURL(url);
}

export function BillingScreen({ apiBaseUrl = 'http://localhost:3001' }: BillingScreenProps) {
  const router = useRouter();
  const { isAdmin, isReady, logout, token } = useAdminSession();
  const [range, setRange] = useState<BillingRange>(getDefaultRange);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [users, setUsers] = useState<BillingUserSummary[]>([]);
  const [groups, setGroups] = useState<BillingLaunchGroup[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [detailView, setDetailView] = useState<DetailView>('users');
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [groupsRevision, setGroupsRevision] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [groupsErrorMessage, setGroupsErrorMessage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const userNameById = useMemo(() => new Map(users.map((user) => [user.userId, user.username])), [users]);
  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!token) {
      setSummary(null);
      setUsers([]);
      setGroups([]);
      setErrorMessage(null);
      setSyncMessage(null);
      setIsLoading(false);
      return;
    }

    if (!isAdmin) {
      router.replace('/admin/scenarios');
      return;
    }

    let isActive = true;
    setErrorMessage(null);
    setIsLoading(true);

    Promise.all([
      fetchBillingSummary(apiBaseUrl, token, range),
      fetchBillingUsers(apiBaseUrl, token, { ...range, limit: 500 }),
    ])
      .then(([summaryPayload, usersPayload]) => {
        if (!isActive) {
          return;
        }

        setSummary(summaryPayload);
        setUsers(usersPayload);
        setSelectedUserId((current) => (current && usersPayload.some((user) => user.userId === current) ? current : ''));
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('账单费用加载失败，请稍后重试。');
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, isAdmin, isReady, logout, range, router, token]);

  useEffect(() => {
    if (!token || !isAdmin) {
      return;
    }

    let isActive = true;
    setIsLoadingGroups(true);
    setGroupsErrorMessage(null);
    setExpandedGroupIds(new Set());

    const request =
      detailView === 'users'
        ? fetchBillingUserGroups(apiBaseUrl, token, { ...range, limit: 100, userId: selectedUserId || undefined })
        : fetchPlatformBillingGroups(apiBaseUrl, token, { ...range, limit: 100 });

    request
      .then((payload) => {
        if (isActive) {
          setGroups(payload);
        }
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          logout();
          router.replace('/admin/login');
          return;
        }

        setGroupsErrorMessage('费用明细加载失败，请稍后重试。');
      })
      .finally(() => {
        if (isActive) {
          setIsLoadingGroups(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, detailView, groupsRevision, isAdmin, logout, range, router, selectedUserId, token]);

  if (!isReady) {
    return null;
  }

  if (!token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
          <p className="admin-empty">检测到当前没有有效的管理员会话。</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在返回主工作台...</h2>
          <p className="admin-empty">当前账号无权访问账单费用。</p>
        </section>
      </main>
    );
  }

  const refreshOverview = async () => {
    if (!token) {
      return;
    }

    const [summaryPayload, usersPayload] = await Promise.all([
      fetchBillingSummary(apiBaseUrl, token, range),
      fetchBillingUsers(apiBaseUrl, token, { ...range, limit: 500 }),
    ]);
    setSummary(summaryPayload);
    setUsers(usersPayload);
  };

  const handleSync = async () => {
    if (!token) {
      return;
    }

    setIsSyncing(true);
    setErrorMessage(null);
    setSyncMessage(null);

    try {
      const result = await triggerBillingSync(apiBaseUrl, token, range);
      await refreshOverview();
      setGroupsRevision((current) => current + 1);
      setSyncMessage(`已同步 ${result.syncedDays} 天，导入 ${result.importedLineItems} 条账单。`);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('账单同步失败，请稍后重试。');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExport = async (kind: BillingExportKind) => {
    if (!token) {
      return;
    }

    if (kind === 'platform') {
      downloadCsv(await exportPlatformBillingCsv(apiBaseUrl, token, range), 'platform-billing.csv');
      return;
    }

    if (kind === 'user' && selectedUserId) {
      downloadCsv(await exportBillingUserItemsCsv(apiBaseUrl, token, selectedUserId, range), `billing-user-${selectedUserId}.csv`);
      return;
    }

    if (kind === 'users') {
      downloadCsv(await exportBillingUsersCsv(apiBaseUrl, token, range), 'billing-users.csv');
    }
  };

  const selectUser = (userId: string) => {
    if (detailView === 'users' && selectedUserId === userId) {
      return;
    }

    setIsLoadingGroups(true);
    setSelectedUserId(userId);
    setDetailView('users');
  };

  const selectDetailView = (view: DetailView) => {
    if (detailView === view) {
      return;
    }

    setIsLoadingGroups(true);
    setDetailView(view);
  };

  const updateRange = (nextRange: BillingRange) => {
    setIsLoadingGroups(true);
    setRange(nextRange);
  };

  const retryGroups = () => {
    setIsLoadingGroups(true);
    setGroupsErrorMessage(null);
    setGroupsRevision((current) => current + 1);
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  return (
    <div className="admin-screen admin-workbench-screen gap-3">
      <section className="admin-workbench-surface">
        <AdminPageHeader
          action={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline">
                    <Download aria-hidden="true" />
                    导出账单
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => void handleExport('platform')}>导出平台账单</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleExport('users')}>导出用户汇总</DropdownMenuItem>
                  <DropdownMenuItem disabled={!selectedUserId} onSelect={() => void handleExport('user')}>
                    导出当前用户
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button disabled={isSyncing} onClick={() => void handleSync()} type="button">
                <RefreshCw aria-hidden="true" className={isSyncing ? 'animate-spin' : undefined} />
                {isSyncing ? '正在同步...' : '立即同步'}
              </Button>
            </>
          }
          description="查看平台开通与公共资源的费用明细。"
          title="账单费用"
        />

        <dl aria-label="账单概览" className="mt-4 flex flex-wrap items-stretch border-l border-border">
          <div className="grid min-w-36 gap-1 border-r border-border px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台总应付</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {summary ? formatMoney(summary.totalPretaxAmount) : isLoading ? <Skeleton className="h-5 w-20" /> : '¥ 0.00'}
            </dd>
          </div>
          <div className="grid min-w-36 gap-1 px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台公共费用</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {summary ? formatMoney(summary.platformPretaxAmount) : isLoading ? <Skeleton className="h-5 w-20" /> : '¥ 0.00'}
            </dd>
          </div>
        </dl>

      {errorMessage ? (
        <p className="mt-4 border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {syncMessage ? (
        <p className="mt-4 border border-emerald-700/20 bg-emerald-700/5 px-3 py-2 text-sm text-emerald-800" role="status">
          {syncMessage}
        </p>
      ) : null}

      <div className="mt-4 grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <section aria-busy={isLoadingGroups || undefined} aria-label="费用明细" className="min-w-0">
          <div className="flex flex-col gap-3 border-b border-border pb-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground">费用明细</h2>
              <p className="mt-1 text-sm text-muted-foreground">按每次开通任务展开关联资源的费用。</p>
            </div>

            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">查看</span>
                <div aria-label="费用明细视图" className="inline-flex w-fit rounded-lg bg-muted p-0.5" role="group">
                  <button
                    aria-pressed={detailView === 'users'}
                    className={
                      detailView === 'users'
                        ? 'h-7 rounded-md bg-background px-2.5 text-xs font-medium text-foreground shadow-sm'
                        : 'h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                    }
                    onClick={() => selectDetailView('users')}
                    type="button"
                  >
                    用户明细
                  </button>
                  <button
                    aria-pressed={detailView === 'platform'}
                    className={
                      detailView === 'platform'
                        ? 'h-7 rounded-md bg-background px-2.5 text-xs font-medium text-foreground shadow-sm'
                        : 'h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                    }
                    onClick={() => selectDetailView('platform')}
                    type="button"
                  >
                    平台费用明细
                  </button>
                </div>
              </div>

              <label className="grid min-w-36 gap-1">
                <span className="text-xs font-medium text-muted-foreground">筛选用户</span>
                <AdminSelectField
                  ariaLabel="筛选用户"
                  className="min-w-36"
                  disabled={detailView === 'platform'}
                  emptyOptionLabel="全部用户"
                  onValueChange={selectUser}
                  options={users.map((user) => ({ label: user.username, value: user.userId }))}
                  value={selectedUserId}
                />
              </label>

              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">账期</span>
                <div className="flex items-center gap-1.5">
                  <label>
                    <span className="sr-only">开始账期</span>
                    <input
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                      onChange={(event) => updateRange({ ...range, startAt: event.target.value })}
                      type="date"
                      value={range.startAt}
                    />
                  </label>
                  <span className="text-xs text-muted-foreground">至</span>
                  <label>
                    <span className="sr-only">结束账期</span>
                    <input
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                      onChange={(event) => updateRange({ ...range, endAt: event.target.value })}
                      type="date"
                      value={range.endAt}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div aria-live="polite" className="mt-3 border-y border-border">
            {groupsErrorMessage ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/15 bg-destructive/5 px-3 py-2 text-sm" role="alert">
                <span className="text-destructive">
                  {groupsErrorMessage}
                  {groups.length ? ' 正在显示上次成功加载的费用明细。' : ''}
                </span>
                <Button onClick={retryGroups} size="sm" type="button" variant="outline">
                  重试加载
                </Button>
              </div>
            ) : null}

            {isLoadingGroups && !groups.length ? (
              <div className="space-y-3 px-3 py-5" role="status" aria-label="正在加载费用明细">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : null}

            {isLoadingGroups && groups.length ? (
              <p className="border-b border-border px-3 py-2 text-sm text-muted-foreground" role="status">
                正在更新费用明细...
              </p>
            ) : null}

            {!groups.length && !isLoadingGroups && !groupsErrorMessage ? (
              <div className="px-3 py-12 text-sm">
                <h3 className="font-medium text-foreground">当前账期没有费用明细</h3>
                <p className="mt-1 text-muted-foreground">
                  {detailView === 'users' ? '当前账期内暂无用户费用明细。' : '当前账期内暂无平台费用明细。'}
                </p>
              </div>
            ) : null}

            {groups.map((group) => {
              const isExpanded = expandedGroupIds.has(group.id);
              const ownerName = group.ownerUserId ? group.ownerUsername ?? userNameById.get(group.ownerUserId) ?? group.ownerUserId : null;
              const groupTime = group.completedAt ? formatAdminDateTime(group.completedAt) : `账期 ${group.billingPeriodStart} 至 ${group.billingPeriodEnd}`;

              return (
                <article key={group.id} className="border-b border-border last:border-b-0">
                  <button
                    aria-expanded={isExpanded}
                    className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none sm:grid-cols-[auto_9rem_minmax(0,1fr)_auto]"
                    onClick={() => toggleGroup(group.id)}
                    type="button"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={isExpanded ? 'size-4 rotate-90 text-primary transition-transform' : 'size-4 text-muted-foreground transition-transform'}
                    />
                    <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">{groupTime}</span>
                    <span className="grid min-w-0 gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <strong className="truncate text-sm font-medium text-foreground">{formatBillingGroupTitle(group)}</strong>
                        {group.provisionJobStatus ? <StatusBadge status={group.provisionJobStatus} /> : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[ownerName, group.instance?.name, `${group.resourceCount} 项资源`].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="inline-flex items-baseline justify-end gap-1 text-right text-sm font-semibold tabular-nums text-foreground">
                      {formatMoney(group.pretaxAmount, group.currency)}
                      <span className="font-medium text-muted-foreground">{group.currency}</span>
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="border-t border-border bg-muted/25 pl-10 sm:pl-10">
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)_22ch]"
                        >
                          <span className="text-muted-foreground">账期 {item.billingDate.slice(0, 10)}</span>
                          <span className="min-w-0 truncate text-foreground">
                            <strong className="font-medium">{formatResourceType(item.cloudResourceType)}</strong> · {item.cloudResourceId}
                          </span>
                          <span
                            className="min-w-0 truncate text-left text-muted-foreground sm:col-start-3"
                            data-slot="billing-line-description"
                          >
                            {item.billItem} · {formatBillingLineSecondary(item)}
                          </span>
                          <span className="col-start-2 inline-flex items-baseline justify-end gap-1 text-right font-semibold tabular-nums text-foreground sm:col-start-4">
                            {formatMoney(item.pretaxAmount, item.currency)}
                            <span className="font-medium text-muted-foreground">{item.currency}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        <aside aria-label="用户账单" className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground">用户账单</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{users.length} 位用户</p>
            </div>
          </div>

          <div className="divide-y divide-border">
            {isLoading && !users.length ? (
              <div className="space-y-3 px-3 py-4" role="status" aria-label="正在加载用户账单">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : null}
            {users.map((user) => (
              <button
                aria-pressed={user.userId === selectedUserId && detailView === 'users'}
                className={
                  user.userId === selectedUserId && detailView === 'users'
                    ? 'flex w-full items-center justify-between gap-3 border-l-2 border-primary bg-accent/60 px-3 py-2.5 text-left'
                    : 'flex w-full items-center justify-between gap-3 border-l-2 border-transparent px-3 py-2.5 text-left hover:bg-muted/60'
                }
                key={user.userId}
                onClick={() => selectUser(user.userId)}
                type="button"
              >
                <span className="grid min-w-0 gap-1">
                  <strong className="truncate text-sm font-medium text-foreground">{user.username}</strong>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.launchCount} 次成功开通 · {user.itemCount} 项费用
                  </span>
                </span>
                <strong className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatMoney(user.pretaxAmount)}</strong>
              </button>
            ))}
            {!users.length && !isLoading ? <p className="px-3 py-8 text-sm text-muted-foreground">当前账期内暂无用户账单。</p> : null}
          </div>
        </aside>
      </div>
      </section>
    </div>
  );
}
