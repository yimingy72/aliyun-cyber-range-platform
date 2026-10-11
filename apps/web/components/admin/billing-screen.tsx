'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react';

import {
  exportBillingUserItemsCsv,
  exportBillingUsersCsv,
  exportPlatformBillingCsv,
  fetchAdminUsers,
  fetchBillingSummary,
  fetchBillingUserGroups,
  fetchBillingUsers,
  fetchPlatformBillingGroups,
  triggerBillingSync,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { AdminUser, BillingLaunchGroup, BillingSummary, BillingUserSummary, PaginatedResult } from '../../lib/admin-types';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Skeleton } from '../ui/skeleton';
import { AdminPaginationControls, buildVisiblePages, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminSelectField } from './shared/admin-select-field';
import { AdminPageHeader } from './shared/admin-page-header';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { StatusBadge } from './shared/status-badge';
import { useAdminRouteIsActive } from './admin-page-cache';
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
type BillingOverviewSnapshot = {
  summary: BillingSummary;
  users: PaginatedResult<BillingUserSummary>;
  filterUsers: AdminUser[];
};

const preciseMoneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 9,
});

function getDefaultRange(): BillingRange {
  const endAt = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}T00:00:00.000Z`);
  const startAt = new Date(endAt);
  startAt.setUTCDate(startAt.getUTCDate() - 29);

  return {
    startAt: startAt.toISOString().slice(0, 10),
    endAt: endAt.toISOString().slice(0, 10),
  };
}

function formatMoney(value: number | null | undefined, currency = 'CNY') {
  if (value === null) return '按币种查看';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  const amount = value;

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
  const workspace = useCloudWorkspace()?.workspace;
  const isPageActive = useAdminRouteIsActive('/admin/billing');
  const screenCache = useAdminScreenCache();
  const [range, setRange] = useState<BillingRange>(getDefaultRange);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [detailView, setDetailView] = useState<DetailView>('users');
  const [groupsPage, setGroupsPage] = useState(1);
  const [usersPage, setUsersPage] = useState(1);
  const [usersJumpPageValue, setUsersJumpPageValue] = useState('1');
  const { pageSize, setPageSize } = useAdminPageSize();
  const overviewResource = `billing:overview:${range.startAt}:${range.endAt}:${usersPage}:${pageSize}`;
  const groupsResource =
    detailView === 'users'
      ? `billing:user-groups:${selectedUserId || 'all'}:${range.startAt}:${range.endAt}:${groupsPage}:${pageSize}`
      : `billing:platform-groups:${range.startAt}:${range.endAt}:${groupsPage}:${pageSize}`;
  const cachedOverview = screenCache?.read<BillingOverviewSnapshot>(apiBaseUrl, token, overviewResource);
  const cachedGroups = screenCache?.read<PaginatedResult<BillingLaunchGroup>>(apiBaseUrl, token, groupsResource);
  const [summary, setSummary] = useState<BillingSummary | null>(() => cachedOverview?.data.summary ?? null);
  const [usersResult, setUsersResult] = useState<PaginatedResult<BillingUserSummary>>(
    () =>
      cachedOverview?.data.users ?? {
        items: [],
        page: 1,
        pageSize,
        total: 0,
      },
  );
  const [groupsResult, setGroupsResult] = useState<PaginatedResult<BillingLaunchGroup>>(
    () =>
      cachedGroups?.data ?? {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      },
  );
  const [filterUsers, setFilterUsers] = useState<AdminUser[]>(() => cachedOverview?.data.filterUsers ?? []);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [loadedOverviewResource, setLoadedOverviewResource] = useState<string | null>(() =>
    cachedOverview ? overviewResource : null,
  );
  const [loadedGroupsResource, setLoadedGroupsResource] = useState<string | null>(() =>
    cachedGroups ? groupsResource : null,
  );
  const [overviewLoadAttempt, setOverviewLoadAttempt] = useState(0);
  const [groupsLoadAttempt, setGroupsLoadAttempt] = useState(0);
  const [groupsJumpPageValue, setGroupsJumpPageValue] = useState('1');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [overviewRevalidationErrorMessage, setOverviewRevalidationErrorMessage] = useState<string | null>(null);
  const [groupsErrorMessage, setGroupsErrorMessage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(() => !cachedOverview);
  const [isRefreshingOverview, setIsRefreshingOverview] = useState(false);
  const [isLoadingGroups, setIsLoadingGroups] = useState(() => !cachedGroups);
  const [isSyncing, setIsSyncing] = useState(false);

  const hasPlatformBillingScope = summary?.billingScope === 'platform_resources';
  const users = usersResult.items;
  const groups = groupsResult.items;
  const hasOverviewSnapshot = loadedOverviewResource !== null;
  const hasGroupsSnapshot = loadedGroupsResource !== null;
  const userNameById = useMemo(
    () =>
      new Map([
        ...filterUsers.map((user) => [user.id, user.username] as const),
        ...users.map((user) => [user.userId, user.username] as const),
      ]),
    [filterUsers, users],
  );
  useEffect(() => {
    if (!isPageActive || !isReady) {
      return;
    }

    if (!token) {
      setSummary(null);
      setUsersResult({ items: [], page: 1, pageSize, total: 0 });
      setGroupsResult({ items: [], page: 1, pageSize, total: 0 });
      setFilterUsers([]);
      setLoadedOverviewResource(null);
      setLoadedGroupsResource(null);
      setOverviewLoadAttempt(0);
      setGroupsLoadAttempt(0);
      setErrorMessage(null);
      setOverviewRevalidationErrorMessage(null);
      setGroupsErrorMessage(null);
      setSyncMessage(null);
      setIsLoading(false);
      setIsRefreshingOverview(false);
      setIsLoadingGroups(false);
      return;
    }

    if (!isAdmin) {
      router.replace('/admin/scenarios');
      return;
    }

    let isActive = true;
    const cachedSnapshot = screenCache?.read<BillingOverviewSnapshot>(apiBaseUrl, token, overviewResource);

    if (cachedSnapshot?.isFresh && overviewLoadAttempt === 0) {
      setSummary(cachedSnapshot.data.summary);
      setUsersResult(cachedSnapshot.data.users);
      setUsersPage(cachedSnapshot.data.users.page);
      setFilterUsers(cachedSnapshot.data.filterUsers);
      setLoadedOverviewResource(overviewResource);
      setSelectedUserId((current) =>
        current && cachedSnapshot.data.filterUsers.some((user) => user.id === current) ? current : '',
      );
      setErrorMessage(null);
      setOverviewRevalidationErrorMessage(null);
      setIsLoading(false);
      setIsRefreshingOverview(false);

      return () => {
        isActive = false;
      };
    }

    if (loadedOverviewResource === overviewResource && !screenCache && overviewLoadAttempt === 0) {
      setIsLoading(false);
      setIsRefreshingOverview(false);

      return () => {
        isActive = false;
      };
    }

    if (hasOverviewSnapshot) {
      setOverviewRevalidationErrorMessage(null);
    } else {
      setErrorMessage(null);
    }
    setIsLoading(!hasOverviewSnapshot);
    setIsRefreshingOverview(hasOverviewSnapshot);

    const loadOverview = async (): Promise<BillingOverviewSnapshot> => {
      const [summary, users, filterUsers] = await Promise.all([
        fetchBillingSummary(apiBaseUrl, token, range),
        fetchBillingUsers(apiBaseUrl, token, { ...range, page: usersPage, pageSize }),
        fetchAdminUsers(apiBaseUrl, token),
      ]);

      return { summary, users, filterUsers };
    };
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, overviewResource, loadOverview, { force: overviewLoadAttempt > 0 })
      : loadOverview();

    request
      .then((snapshot) => {
        if (!isActive) {
          return;
        }

        setSummary(snapshot.summary);
        setUsersResult(snapshot.users);
        setUsersPage(snapshot.users.page);
        setFilterUsers(snapshot.filterUsers);
        setLoadedOverviewResource(overviewResource);
        setSelectedUserId((current) =>
          current && snapshot.filterUsers.some((user) => user.id === current) ? current : '',
        );
        setOverviewRevalidationErrorMessage(null);
        if (overviewLoadAttempt > 0) {
          setOverviewLoadAttempt(0);
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

        const message = '账单费用加载失败，请稍后重试。';

        if (hasOverviewSnapshot) {
          setOverviewRevalidationErrorMessage(message);
          return;
        }

        setErrorMessage(message);
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
          setIsRefreshingOverview(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [
    apiBaseUrl,
    hasOverviewSnapshot,
    isAdmin,
    isPageActive,
    isReady,
    loadedOverviewResource,
    logout,
    overviewLoadAttempt,
    overviewResource,
    pageSize,
    usersPage,
    range,
    router,
    screenCache,
    token,
  ]);

  useEffect(() => {
    if (!isPageActive || !isReady || !token || !isAdmin) {
      return;
    }

    let isActive = true;
    const cachedSnapshot = screenCache?.read<PaginatedResult<BillingLaunchGroup>>(apiBaseUrl, token, groupsResource);

    if (cachedSnapshot?.isFresh && groupsLoadAttempt === 0) {
      setGroupsResult(cachedSnapshot.data);
      setGroupsPage(cachedSnapshot.data.page);
      setLoadedGroupsResource(groupsResource);
      setGroupsErrorMessage(null);
      setIsLoadingGroups(false);

      return () => {
        isActive = false;
      };
    }

    if (loadedGroupsResource === groupsResource && !screenCache && groupsLoadAttempt === 0) {
      setIsLoadingGroups(false);

      return () => {
        isActive = false;
      };
    }

    setIsLoadingGroups(true);
    setGroupsErrorMessage(null);

    const loadGroups = () =>
      detailView === 'users'
        ? fetchBillingUserGroups(apiBaseUrl, token, {
            ...range,
            page: groupsPage,
            pageSize,
            userId: selectedUserId || undefined,
          })
        : fetchPlatformBillingGroups(apiBaseUrl, token, { ...range, page: groupsPage, pageSize });
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, groupsResource, loadGroups, { force: groupsLoadAttempt > 0 })
      : loadGroups();

    request
      .then((payload) => {
        if (isActive) {
          setGroupsResult(payload);
          setGroupsPage(payload.page);
          setLoadedGroupsResource(groupsResource);
          if (groupsLoadAttempt > 0) {
            setGroupsLoadAttempt(0);
          }
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
  }, [
    apiBaseUrl,
    detailView,
    groupsLoadAttempt,
    groupsPage,
    groupsResource,
    isAdmin,
    isPageActive,
    isReady,
    loadedGroupsResource,
    logout,
    pageSize,
    range,
    router,
    screenCache,
    selectedUserId,
    token,
  ]);

  const usersPagination = getPagination(usersResult.total, usersResult.page, usersResult.pageSize);
  const usersVisiblePages = buildVisiblePages(usersPagination.totalPages, usersPagination.page);

  useLayoutEffect(() => setUsersJumpPageValue(String(usersPagination.page)), [usersPagination.page]);

  const groupsPagination = getPagination(groupsResult.total, groupsResult.page, groupsResult.pageSize);
  const groupsVisiblePages = buildVisiblePages(groupsPagination.totalPages, groupsPagination.page);

  useLayoutEffect(() => {
    setGroupsJumpPageValue(String(groupsPagination.page));
  }, [groupsPagination.page]);

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

  const handleSync = async () => {
    if (!token) {
      return;
    }

    setIsSyncing(true);
    setErrorMessage(null);
    setSyncMessage(null);

    try {
      const result = await triggerBillingSync(apiBaseUrl, token, range);
      screenCache?.invalidate(apiBaseUrl, token, 'billing:');
      setGroupsPage(1);
      setGroupsLoadAttempt((current) => current + 1);
      setOverviewLoadAttempt((current) => current + 1);
      setSyncMessage(result.syncInProgress ? '已有账单同步进行中，请稍后刷新。'
        : `已同步 ${result.syncedDays} 天，导入 ${result.importedLineItems} 条账单。${result.deferredDates?.length ? ' 未完成的账期已延后同步，不代表费用为零。' : ''}`);
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

    setErrorMessage(null);
    try {
      if (kind === 'platform') {
        downloadCsv(await exportPlatformBillingCsv(apiBaseUrl, token, range), 'platform-billing.csv');
      } else if (kind === 'user' && selectedUserId) {
        downloadCsv(await exportBillingUserItemsCsv(apiBaseUrl, token, selectedUserId, range), `billing-user-${selectedUserId}.csv`);
      } else if (kind === 'users') {
        downloadCsv(await exportBillingUsersCsv(apiBaseUrl, token, range), 'billing-users.csv');
      }
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        logout();
        router.replace('/admin/login');
        return;
      }
      setErrorMessage('账单导出失败，请稍后重试。');
    }
  };

  const selectUser = (userId: string) => {
    if (detailView === 'users' && selectedUserId === userId) {
      return;
    }

    setIsLoadingGroups(true);
    setSelectedUserId(userId);
    setDetailView('users');
    setGroupsPage(1);
  };

  const selectDetailView = (view: DetailView) => {
    if (detailView === view) {
      return;
    }

    setIsLoadingGroups(true);
    setDetailView(view);
    setGroupsPage(1);
  };

  const updateRange = (nextRange: BillingRange) => {
    setIsLoadingGroups(true);
    setGroupsPage(1);
    setUsersPage(1);
    setRange(nextRange);
  };

  const handlePageSizeChange = (nextPageSize: 20 | 50 | 100) => {
    setPageSize(nextPageSize);
    setGroupsPage(1);
    setUsersPage(1);
  };

  const handleGroupsJump = () => {
    const parsedPage = Number.parseInt(groupsJumpPageValue, 10);
    setGroupsPage(Number.isNaN(parsedPage) ? groupsPagination.page : parsedPage);
  };

  const retryGroups = () => {
    setIsLoadingGroups(true);
    setGroupsErrorMessage(null);
    setGroupsLoadAttempt((current) => current + 1);
  };

  const retryOverview = () => {
    setErrorMessage(null);
    setOverviewRevalidationErrorMessage(null);
    setOverviewLoadAttempt((current) => current + 1);
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
    <div className="admin-screen admin-workbench-screen admin-pagination-screen gap-3 max-lg:h-auto! max-lg:min-h-full!">
      <section className="admin-workbench-surface admin-pagination-surface max-lg:flex-none! max-lg:overflow-visible!">
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
              <Button disabled={isSyncing || Boolean(workspace && !workspace.capabilities.billingSync)} title={workspace && !workspace.capabilities.billingSync ? '当前云账号尚未开放账单同步。' : undefined} onClick={() => void handleSync()} type="button">
                <RefreshCw aria-hidden="true" className={isSyncing ? 'animate-spin' : undefined} />
                {isSyncing ? '正在同步...' : '立即同步'}
              </Button>
            </>
          }
          description="仅统计平台创建资源的应付费用。账单可能因延迟出账、退款或调账继续变化。"
          title="账单费用"
        />

        <dl
          aria-busy={isRefreshingOverview || undefined}
          aria-label="账单概览"
          className="mt-4 flex flex-wrap items-stretch gap-y-3 border-l border-border"
        >
          <div className="grid min-w-36 gap-1 border-r border-border px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台已归属费用</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {hasPlatformBillingScope ? summary.currencyTotals?.length ? summary.currencyTotals.map(item => <span className="block" key={item.currency}>{formatMoney(item.totalPretaxAmount, item.currency)}</span>) : formatMoney(summary.totalPretaxAmount, summary.currency ?? 'CNY') : summary ? '范围待确认' : isLoading ? <Skeleton className="h-5 w-20" /> : '未知'}
            </dd>
          </div>
          <div className="grid min-w-36 gap-1 border-r border-border px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台公共费用</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {hasPlatformBillingScope ? summary.currencyTotals?.length ? summary.currencyTotals.map(item => <span className="block" key={item.currency}>{formatMoney(item.platformPretaxAmount, item.currency)}</span>) : formatMoney(summary.platformPretaxAmount, summary.currency ?? 'CNY') : summary ? '范围待确认' : isLoading ? <Skeleton className="h-5 w-20" /> : '未知'}
            </dd>
          </div>
          <div className="grid min-w-36 gap-1 border-r border-border px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台待分配费用</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {hasPlatformBillingScope && summary.unallocatedCurrencyTotals
                ? summary.unallocatedCurrencyTotals.length
                  ? summary.unallocatedCurrencyTotals.map(item => <span className="block" key={item.currency}>{formatMoney(item.pretaxAmount, item.currency)}</span>)
                  : '无未分配记录'
                : summary && !hasPlatformBillingScope ? '范围待确认' : isLoading && !summary ? <Skeleton className="h-5 w-20" /> : '未知'}
            </dd>
          </div>
          <div className="grid min-w-36 gap-1 px-4">
            <dt className="text-xs font-medium text-muted-foreground">平台资源待对账</dt>
            <dd className="text-base font-semibold tabular-nums text-foreground">
              {hasPlatformBillingScope && typeof summary.resourcesWithoutBillCount === 'number' ? `${summary.resourcesWithoutBillCount} 项`
                : summary && !hasPlatformBillingScope ? '范围待确认' : isLoading && !summary ? <Skeleton className="h-5 w-20" /> : '未知'}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          待出账不代表免费。平台待分配费用已确认属于平台，尚未计入用户或平台公共费用。
          {summary && !hasPlatformBillingScope
            ? ' 账单范围尚未确认，暂不展示平台汇总。'
            : summary && (summary.billingStatus === undefined || summary.unallocatedCurrencyTotals === undefined || summary.resourcesWithoutBillCount === undefined || summary.reconciliationIssues === undefined)
              ? ' 对账信息尚不完整，未知项不能按零计算。' : null}
        </p>

        {hasPlatformBillingScope && summary.anomalyCount > 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{summary.anomalyCount} 条平台账单待分配，汇总仅包含已归属费用。</p>
        ) : null}
        {hasPlatformBillingScope && summary.reconciliationIssues?.length ? (
          <ul aria-label="平台资源对账提示" className="mt-2 grid gap-1 text-xs leading-5 text-muted-foreground">
            {summary.reconciliationIssues.map((issue, index) => (
              <li className="break-words" key={`${issue.resourceType}-${index}`}>
                {issue.resourceType === 'unknown'
                  ? `平台资源来源待核验：${issue.resourceCount} 项。`
                  : `${issue.resourceType === 'snapshot' ? '快照' : 'OSS'}：${issue.resourceCount} 项平台资源待核对。`}{issue.reason}
              </li>
            ))}
          </ul>
        ) : null}

        {errorMessage ? (
          <p className="mt-4 border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {overviewRevalidationErrorMessage ? (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm"
            role="alert"
          >
            <span className="text-destructive">
              {overviewRevalidationErrorMessage} 正在显示上次成功加载的账单数据。
            </span>
            <Button aria-label="重试加载账单概览" onClick={retryOverview} size="sm" type="button" variant="outline">
              重试加载
            </Button>
          </div>
        ) : null}
      {syncMessage ? (
        <p className="mt-4 border border-emerald-700/20 bg-emerald-700/5 px-3 py-2 text-sm text-emerald-800" role="status">
          {syncMessage}
        </p>
      ) : null}

      <div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col items-stretch gap-5 max-lg:flex-none lg:grid lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section aria-busy={isLoadingGroups || undefined} aria-label="费用明细" className="flex min-w-0 min-h-0 flex-col max-lg:shrink-0">
          <div className="billing-detail-panel-header flex flex-col gap-3 border-b border-border pb-3 lg:flex-row lg:items-end lg:justify-between">
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
                  options={filterUsers.map((user) => ({ label: user.username, value: user.id }))}
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

          <p className="mt-2 text-xs leading-5 text-muted-foreground">整月对账可选择月初至月末后同步；上月账单建议在次月 3 日 12 点后核对。</p>

          <AdminPaginatedList
            className="mt-3 max-lg:flex-none! max-lg:grid-rows-[auto_auto]! max-lg:[&>.admin-paginated-list-body]:overflow-visible!"
            footer={
              groupsResult.total > 0 && !groupsErrorMessage ? (
                <AdminPaginationControls
                  jumpPageValue={groupsJumpPageValue}
                  label="费用明细分页"
                  pageSize={groupsResult.pageSize}
                  pagination={groupsPagination}
                  visiblePages={groupsVisiblePages}
                  onJumpPage={handleGroupsJump}
                  onJumpPageValueChange={setGroupsJumpPageValue}
                  onNextPage={() => setGroupsPage(groupsPagination.page + 1)}
                  onPageSelect={setGroupsPage}
                  onPageSizeChange={handlePageSizeChange}
                  onPreviousPage={() => setGroupsPage(groupsPagination.page - 1)}
                />
              ) : null
            }
          >
          <div aria-live="polite" className="overflow-hidden rounded border border-border bg-background">
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

            {isLoadingGroups && !hasGroupsSnapshot ? (
              <div className="space-y-3 px-3 py-5" role="status" aria-label="正在加载费用明细">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : null}

            {isLoadingGroups && hasGroupsSnapshot ? (
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
          </AdminPaginatedList>
        </section>

      <aside aria-label="用户账单" className="billing-users-panel flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card max-lg:shrink-0">
        <div className="billing-users-panel-header flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-3">
          <div>
            <h2 className="font-heading text-base font-semibold text-foreground">用户账单</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{usersResult.total} 位用户</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto max-lg:flex-none">
          {isLoading && !hasOverviewSnapshot ? (
            <div className="space-y-3 px-3 py-4" role="status" aria-label="正在加载用户账单">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : null}
          {isLoading && hasOverviewSnapshot ? (
            <p className="border-b border-border px-3 py-2 text-sm text-muted-foreground" role="status">
              正在更新用户账单...
            </p>
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
                  {user.launchCount} 个已出账开通任务 · {user.itemCount} 项费用
                </span>
              </span>
              <strong className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{user.amounts?.length ? user.amounts.map(item => <span className="block" key={item.currency}>{formatMoney(item.pretaxAmount, item.currency)}</span>) : formatMoney(user.pretaxAmount, user.currency ?? 'CNY')}</strong>
            </button>
          ))}
          {!users.length && !isLoading ? <p className="px-3 py-8 text-sm text-muted-foreground">当前账期内暂无用户账单。</p> : null}
        </div>
        {usersResult.total > usersResult.pageSize ? (
          <div className="shrink-0 border-t border-border px-2 py-2 [&_.admin-pagination-actions]:flex-wrap [&_.admin-pagination-navigation]:flex-wrap [&_.admin-pagination-pages]:flex-wrap">
            <AdminPaginationControls
              label="用户账单分页" pagination={usersPagination} visiblePages={usersVisiblePages}
              pageSize={usersResult.pageSize} jumpPageValue={usersJumpPageValue}
              onJumpPageValueChange={setUsersJumpPageValue}
              onJumpPage={() => { const page = Number.parseInt(usersJumpPageValue, 10); setUsersPage(Number.isNaN(page) ? usersPagination.page : page); }}
              onNextPage={() => setUsersPage(usersPagination.page + 1)}
              onPreviousPage={() => setUsersPage(usersPagination.page - 1)}
              onPageSelect={setUsersPage} onPageSizeChange={handlePageSizeChange}
            />
          </div>
        ) : null}
      </aside>
      </div>
      </section>
    </div>
  );
}
