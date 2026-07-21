'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

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
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [groupsRevision, setGroupsRevision] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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

        setGroups([]);
        setErrorMessage('费用明细加载失败，请稍后重试。');
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

    setIsExportMenuOpen(false);

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
    setSelectedUserId(userId);
    setDetailView('users');
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
    <div className="admin-screen admin-workbench-screen billing-screen">
      <section className="admin-workbench-panel billing-page-header">
        <div className="billing-page-title">
          <h2>账单费用</h2>
        </div>
        <div className="billing-page-totals" aria-label="账单概览">
          <div>
            <span>平台总应付</span>
            <strong>{summary ? formatMoney(summary.totalPretaxAmount) : isLoading ? '加载中...' : '¥ 0.00'}</strong>
          </div>
          <div>
            <span>平台公共费用</span>
            <strong>{summary ? formatMoney(summary.platformPretaxAmount) : isLoading ? '加载中...' : '¥ 0.00'}</strong>
          </div>
        </div>
        <div className="billing-page-actions">
          <div className="billing-export-menu">
            <button
              type="button"
              className="template-workbench-secondary-action"
              aria-expanded={isExportMenuOpen}
              onClick={() => setIsExportMenuOpen((current) => !current)}
            >
              导出账单
            </button>
            {isExportMenuOpen ? (
              <div className="billing-export-menu-options" role="group" aria-label="账单导出选项">
                <button type="button" onClick={() => void handleExport('platform')}>
                  导出平台账单
                </button>
                <button type="button" onClick={() => void handleExport('users')}>
                  导出用户汇总
                </button>
                <button type="button" disabled={!selectedUserId} onClick={() => void handleExport('user')}>
                  导出当前用户
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" className="template-workbench-primary-action" onClick={() => void handleSync()} disabled={isSyncing}>
            {isSyncing ? '正在同步...' : '立即同步'}
          </button>
        </div>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}
      {syncMessage ? <p className="admin-success">{syncMessage}</p> : null}

      <div className="billing-screen-body">
        <section className="admin-workbench-panel billing-detail-workspace">
          <div className="billing-detail-toolbar">
            <h2>费用明细</h2>
            <div className="billing-detail-switch" role="group" aria-label="费用明细视图">
              <button
                type="button"
                className={detailView === 'users' ? 'is-active' : ''}
                aria-pressed={detailView === 'users'}
                onClick={() => setDetailView('users')}
              >
                用户明细
              </button>
              <button
                type="button"
                className={detailView === 'platform' ? 'is-active' : ''}
                aria-pressed={detailView === 'platform'}
                onClick={() => setDetailView('platform')}
              >
                平台费用明细
              </button>
            </div>
            <label className="billing-user-filter">
              <span>筛选用户</span>
              <select value={selectedUserId} disabled={detailView === 'platform'} onChange={(event) => selectUser(event.target.value)}>
                <option value="">全部用户</option>
                {users.map((user) => (
                  <option key={user.userId} value={user.userId}>
                    {user.username}
                  </option>
                ))}
              </select>
            </label>
            <div className="billing-date-filter">
              <label>
                <span>账期</span>
                <input type="date" value={range.startAt} onChange={(event) => setRange((current) => ({ ...current, startAt: event.target.value }))} />
              </label>
              <span>至</span>
              <label>
                <span className="sr-only">结束账期</span>
                <input type="date" value={range.endAt} onChange={(event) => setRange((current) => ({ ...current, endAt: event.target.value }))} />
              </label>
            </div>
          </div>

          <div className="billing-group-list" aria-live="polite">
            {groups.map((group) => {
              const isExpanded = expandedGroupIds.has(group.id);
              const ownerName = group.ownerUserId ? group.ownerUsername ?? userNameById.get(group.ownerUserId) ?? group.ownerUserId : null;
              const groupTime = group.completedAt ? formatAdminDateTime(group.completedAt) : `账期 ${group.billingPeriodStart} 至 ${group.billingPeriodEnd}`;

              return (
                <article key={group.id} className={isExpanded ? 'billing-launch-group is-expanded' : 'billing-launch-group'}>
                  <button type="button" className="billing-launch-summary" aria-expanded={isExpanded} onClick={() => toggleGroup(group.id)}>
                    <span className="billing-launch-toggle">{isExpanded ? '⌄' : '›'}</span>
                    <span className="billing-launch-time">{groupTime}</span>
                    <span className="billing-launch-copy">
                      <strong>{group.title}</strong>
                      <span>{[ownerName, group.instance?.name, `${group.resourceCount} 项资源`].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="billing-launch-amount">{formatMoney(group.pretaxAmount, group.currency)}</span>
                  </button>
                  {isExpanded ? (
                    <div className="billing-launch-children">
                      {group.items.map((item) => (
                        <div key={item.id} className="billing-launch-item">
                          <span>账期 {item.billingDate.slice(0, 10)}</span>
                          <span>
                            <strong>{formatResourceType(item.cloudResourceType)}</strong> · {item.cloudResourceId}
                          </span>
                          <span>{item.billItem} · {formatBillingLineSecondary(item)}</span>
                          <span className="billing-launch-item-amount">
                            <strong>{formatMoney(item.pretaxAmount, item.currency)}</strong>
                            <span>{item.currency}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {!groups.length && !isLoadingGroups ? (
              <p className="admin-empty billing-panel-empty">
                {detailView === 'users' ? '当前账期内暂无用户费用明细。' : '当前账期内暂无平台费用明细。'}
              </p>
            ) : null}
          </div>
        </section>

        <aside className="admin-workbench-panel billing-users-panel">
          <div className="admin-workbench-panel-header">
            <div>
              <h2>用户账单</h2>
              <span>{users.length} 位用户</span>
            </div>
          </div>
          <div className="billing-user-list">
            {users.map((user) => (
              <button
                key={user.userId}
                type="button"
                className={user.userId === selectedUserId && detailView === 'users' ? 'billing-user-row is-active' : 'billing-user-row'}
                onClick={() => selectUser(user.userId)}
              >
                <div className="billing-row-copy">
                  <strong>{user.username}</strong>
                  <span>{user.launchCount} 次成功开通 · {user.itemCount} 项费用</span>
                </div>
                <strong>{formatMoney(user.pretaxAmount)}</strong>
              </button>
            ))}
            {!users.length && !isLoading ? <p className="admin-empty billing-panel-empty">当前账期内暂无用户账单。</p> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
