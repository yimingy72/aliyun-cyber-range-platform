'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  exportBillingUserItemsCsv,
  exportBillingUsersCsv,
  fetchPlatformBillingItems,
  exportPlatformBillingCsv,
  fetchBillingAnomalies,
  fetchBillingSummary,
  fetchBillingUserItems,
  fetchBillingUsers,
  triggerBillingSync,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { BillingAnomaly, BillingLineItem, BillingSummary, BillingUserSummary } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type BillingScreenProps = {
  apiBaseUrl?: string;
};

type BillingRange = {
  startAt: string;
  endAt: string;
};

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

function formatMoney(value: number) {
  return `¥ ${preciseMoneyFormatter.format(Number.isFinite(value) ? value : 0)}`;
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

function formatBillingLineSecondary(item: BillingLineItem) {
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
  const session = useAdminSession();
  const { isAdmin, isReady, logout, token } = session;
  const [range, setRange] = useState<BillingRange>(getDefaultRange);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [users, setUsers] = useState<BillingUserSummary[]>([]);
  const [platformItems, setPlatformItems] = useState<BillingLineItem[]>([]);
  const [anomalies, setAnomalies] = useState<BillingAnomaly[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserItems, setSelectedUserItems] = useState<BillingLineItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUserItems, setIsLoadingUserItems] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const selectedUser = useMemo(
    () => (selectedUserId ? users.find((user) => user.userId === selectedUserId) ?? null : null),
    [selectedUserId, users],
  );
  const hasAnomalies = (summary?.anomalyCount ?? anomalies.length) > 0;

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!token) {
      setSummary(null);
      setUsers([]);
      setPlatformItems([]);
      setAnomalies([]);
      setSelectedUserId(null);
      setSelectedUserItems([]);
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
      fetchBillingUsers(apiBaseUrl, token, { ...range, limit: 50 }),
      fetchPlatformBillingItems(apiBaseUrl, token, { ...range, limit: 200 }),
      fetchBillingAnomalies(apiBaseUrl, token, { ...range, limit: 30 }),
    ])
      .then(([summaryPayload, usersPayload, platformItemsPayload, anomaliesPayload]) => {
        if (!isActive) {
          return;
        }

        setSummary(summaryPayload);
        setUsers(usersPayload);
        setPlatformItems(platformItemsPayload);
        setAnomalies(anomaliesPayload);
        setSyncMessage(null);
        setSelectedUserId((current) => (current && usersPayload.some((user) => user.userId === current) ? current : null));
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
    if (!token || !selectedUserId || !isAdmin) {
      setSelectedUserItems([]);
      return;
    }

    let isActive = true;
    setIsLoadingUserItems(true);

    fetchBillingUserItems(apiBaseUrl, token, selectedUserId, { ...range, limit: 100 })
      .then((items) => {
        if (isActive) {
          setSelectedUserItems(items);
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

        setSelectedUserItems([]);
      })
      .finally(() => {
        if (isActive) {
          setIsLoadingUserItems(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, isAdmin, logout, range, router, selectedUserId, token]);

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
      setSyncMessage(`已同步 ${result.syncedDays} 天，导入 ${result.importedLineItems} 条账单。`);
      const [summaryPayload, usersPayload, platformItemsPayload, anomaliesPayload] = await Promise.all([
        fetchBillingSummary(apiBaseUrl, token, range),
        fetchBillingUsers(apiBaseUrl, token, { ...range, limit: 50 }),
        fetchPlatformBillingItems(apiBaseUrl, token, { ...range, limit: 200 }),
        fetchBillingAnomalies(apiBaseUrl, token, { ...range, limit: 30 }),
      ]);
      setSummary(summaryPayload);
      setUsers(usersPayload);
      setPlatformItems(platformItemsPayload);
      setAnomalies(anomaliesPayload);
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

  const handleExportPlatform = async () => {
    if (!token) {
      return;
    }

    const csv = await exportPlatformBillingCsv(apiBaseUrl, token, range);
    downloadCsv(csv, 'platform-billing.csv');
  };

  const handleExportUsers = async () => {
    if (!token) {
      return;
    }

    const csv = await exportBillingUsersCsv(apiBaseUrl, token, range);
    downloadCsv(csv, 'billing-users.csv');
  };

  const handleExportUserItems = async () => {
    if (!token || !selectedUserId) {
      return;
    }

    const csv = await exportBillingUserItemsCsv(apiBaseUrl, token, selectedUserId, range);
    downloadCsv(csv, `billing-user-${selectedUserId}.csv`);
  };

  return (
    <div className="admin-screen admin-workbench-screen billing-screen">
      <section className="admin-workbench-panel billing-screen-filter">
        <div className="template-workbench-list-header billing-screen-header">
          <div className="template-workbench-list-header-copy billing-screen-header-copy">
            <h2>账单费用</h2>
          </div>
          <div className="template-workbench-list-header-meta billing-screen-actions">
            <button type="button" className="template-workbench-secondary-action" onClick={() => void handleExportPlatform()}>
              导出平台账单
            </button>
            <button type="button" className="template-workbench-secondary-action" onClick={() => void handleExportUsers()}>
              导出用户汇总
            </button>
            <button
              type="button"
              className="template-workbench-secondary-action"
              onClick={() => void handleExportUserItems()}
              disabled={!selectedUserId}
            >
              导出当前用户
            </button>
            <button type="button" className="template-workbench-primary-action" onClick={() => void handleSync()} disabled={isSyncing}>
              {isSyncing ? '正在同步...' : '立即同步'}
            </button>
          </div>
        </div>
        <div className="billing-screen-filter-row">
          <label className="billing-filter-field">
            <span>开始日期</span>
            <input
              type="date"
              value={range.startAt}
              onChange={(event) => setRange((current) => ({ ...current, startAt: event.target.value }))}
            />
          </label>
          <label className="billing-filter-field">
            <span>结束日期</span>
            <input
              type="date"
              value={range.endAt}
              onChange={(event) => setRange((current) => ({ ...current, endAt: event.target.value }))}
            />
          </label>
        </div>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}
      {syncMessage ? <p className="admin-success">{syncMessage}</p> : null}

      <section className="admin-workbench-panel billing-summary-grid">
        <article className="billing-summary-card">
          <span className="billing-summary-label">平台总应付</span>
          <strong className="billing-summary-value">{summary ? formatMoney(summary.totalPretaxAmount) : isLoading ? '加载中...' : '¥ 0.00'}</strong>
          <p className="billing-summary-meta">已纳入平台账单范围</p>
        </article>
        <article className="billing-summary-card">
          <span className="billing-summary-label">平台公共费用</span>
          <strong className="billing-summary-value">{summary ? formatMoney(summary.platformPretaxAmount) : isLoading ? '加载中...' : '¥ 0.00'}</strong>
          <p className="billing-summary-meta">未分摊到具体用户</p>
        </article>
        <article className={hasAnomalies ? 'billing-summary-card is-warning' : 'billing-summary-card is-clear'}>
          <span className="billing-summary-label">待确认归属</span>
          <strong className="billing-summary-value">{summary ? `${summary.anomalyCount} 条` : isLoading ? '加载中...' : '0 条'}</strong>
          <p className="billing-summary-meta">{hasAnomalies ? '需要补规则或补台账' : '当前没有待确认项'}</p>
        </article>
      </section>
      <div className="billing-screen-body">
        <div className="billing-screen-primary">
          <section className="admin-workbench-panel billing-user-items-panel">
            <div className="admin-workbench-panel-header">
              <div>
                <h2>{selectedUser ? `${selectedUser.username} 费用明细` : '用户费用明细'}</h2>
                <span>{selectedUser ? `${selectedUser.itemCount} 项` : '请选择用户'}</span>
              </div>
            </div>
            <div className="billing-detail-list">
              <div className="billing-detail-head" aria-hidden="true">
                <span>消费时间</span>
                <span>账单项</span>
                <span>资源</span>
                <span>金额</span>
              </div>
              {selectedUserItems.map((item) => (
                <div key={item.id} className="billing-detail-row">
                  <div className="billing-detail-cell billing-detail-time">
                    <strong>{formatAdminDateTime(item.billingDate)}</strong>
                    <span>{item.billCycle}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-main">
                    <strong>{item.billItem}</strong>
                    <span>{formatBillingLineSecondary(item)}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-resource">
                    <strong>{formatResourceType(item.cloudResourceType)}</strong>
                    <span>{item.cloudResourceId}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-amount">
                    <strong>{formatMoney(item.pretaxAmount)}</strong>
                    <span>{item.currency}</span>
                  </div>
                </div>
              ))}
              {!selectedUserItems.length && !isLoadingUserItems ? (
                <p className="admin-empty billing-panel-empty">{selectedUser ? '当前用户暂无账单明细。' : '先从右侧选择一个用户查看明细。'}</p>
              ) : null}
            </div>
          </section>

          <section className="admin-workbench-panel billing-platform-items-panel">
            <div className="admin-workbench-panel-header">
              <div>
                <h2>平台公共费用明细</h2>
                <span>{platformItems.length} 项</span>
              </div>
            </div>
            <div className="billing-detail-list">
              <div className="billing-detail-head" aria-hidden="true">
                <span>消费时间</span>
                <span>账单项</span>
                <span>资源</span>
                <span>金额</span>
              </div>
              {platformItems.map((item) => (
                <div key={item.id} className="billing-detail-row">
                  <div className="billing-detail-cell billing-detail-time">
                    <strong>{formatAdminDateTime(item.billingDate)}</strong>
                    <span>{item.billCycle}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-main">
                    <strong>{item.billItem}</strong>
                    <span>{formatBillingLineSecondary(item)}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-resource">
                    <strong>{formatResourceType(item.cloudResourceType)}</strong>
                    <span>{item.cloudResourceId}</span>
                  </div>
                  <div className="billing-detail-cell billing-detail-amount">
                    <strong>{formatMoney(item.pretaxAmount)}</strong>
                    <span>{item.currency}</span>
                  </div>
                </div>
              ))}
              {!platformItems.length && !isLoading ? <p className="admin-empty billing-panel-empty">当前时间范围内暂无平台公共费用。</p> : null}
            </div>
          </section>

          {hasAnomalies || isLoading ? (
            <section className="admin-workbench-panel billing-anomalies-panel">
              <div className="admin-workbench-panel-header">
                <div>
                  <h2>待确认归属</h2>
                  <span>{anomalies.length} 条</span>
                </div>
              </div>
              <div className="billing-detail-list">
                <div className="billing-detail-head" aria-hidden="true">
                  <span>消费时间</span>
                  <span>原因</span>
                  <span>资源</span>
                  <span>金额</span>
                </div>
                {anomalies.map((item) => (
                  <div key={item.id} className="billing-detail-row is-warning">
                    <div className="billing-detail-cell billing-detail-time">
                      <strong>{formatAdminDateTime(item.billingDate)}</strong>
                      <span>{item.billCycle}</span>
                    </div>
                    <div className="billing-detail-cell billing-detail-main">
                      <strong>{item.reason}</strong>
                      <span>待补归属规则或台账映射</span>
                    </div>
                    <div className="billing-detail-cell billing-detail-resource">
                      <strong>{formatResourceType(item.cloudResourceType)}</strong>
                      <span>{item.cloudResourceId}</span>
                    </div>
                    <div className="billing-detail-cell billing-detail-amount">
                      <strong>{formatMoney(item.pretaxAmount)}</strong>
                      <span>{item.currency}</span>
                    </div>
                  </div>
                ))}
                {!anomalies.length && !isLoading ? <p className="admin-empty billing-panel-empty">当前时间范围内没有待确认账单。</p> : null}
              </div>
            </section>
          ) : (
            <section className="admin-workbench-panel billing-status-panel">
              <div className="billing-status-pill is-success">当前没有待确认账单</div>
            </section>
          )}
        </div>

        <aside className="billing-screen-sidebar">
          <section className="admin-workbench-panel billing-users-panel">
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
                  className={user.userId === selectedUserId ? 'billing-user-row is-active' : 'billing-user-row'}
                  onClick={() => setSelectedUserId(user.userId)}
                >
                  <div className="billing-row-copy">
                    <strong>{user.username}</strong>
                    <span>{user.itemCount} 项账单</span>
                  </div>
                  <strong>{formatMoney(user.pretaxAmount)}</strong>
                </button>
              ))}
              {!users.length && !isLoading ? <p className="admin-empty billing-panel-empty">当前时间范围内暂无用户账单。</p> : null}
            </div>
          </section>

          <section className="admin-workbench-panel billing-resource-breakdown">
            <div className="admin-workbench-panel-header">
              <div>
                <h2>资源类型汇总</h2>
                <span>{summary?.resourceTypeTotals.length ?? 0} 类</span>
              </div>
            </div>
            <div className="billing-simple-table">
              {(summary?.resourceTypeTotals ?? []).map((item) => (
                <div key={item.resourceType} className="billing-simple-row">
                  <div className="billing-row-copy">
                    <strong>{formatResourceType(item.resourceType)}</strong>
                    <span>{item.resourceType}</span>
                  </div>
                  <strong>{formatMoney(item.pretaxAmount)}</strong>
                </div>
              ))}
              {!summary?.resourceTypeTotals.length && !isLoading ? <p className="admin-empty billing-panel-empty">当前时间范围内暂无平台账单。</p> : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
