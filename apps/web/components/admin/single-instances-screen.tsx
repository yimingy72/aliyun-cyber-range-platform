'use client';

import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  AdminApiError,
  deleteRangeInstance,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  fetchProvisionJobs,
  fetchSingleInstances,
  launchSingleInstances,
  triggerSingleInstanceAction,
} from '../../lib/admin-api';
import type {
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  ProvisionJob,
  RangeInstance,
  SingleInstanceAction,
  SingleInstanceLaunchInput,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type SingleInstancesScreenProps = {
  apiBaseUrl?: string;
};

type ListMode = 'active' | 'history';

type CreateDialogState = {
  name: string;
  hostName: string;
  platformImageQuery: string;
  cpu: string;
  memory: string;
  systemDiskSize: string;
  expiresAt: string;
  password: string;
  quantity: string;
  remark: string;
};

type MenuAction = SingleInstanceAction | 'delete-record';

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return '暂无';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
}

function formatDuration(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return '暂无';
  }

  const startedAt = new Date(start);
  const endedAt = new Date(end);

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return '暂无';
  }

  const totalMinutes = Math.floor((endedAt.getTime() - startedAt.getTime()) / 60000);

  if (totalMinutes <= 0) {
    return '暂无';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function getStatusLabel(status: string) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'pending_create' || status === 'creating') {
    return '创建中';
  }

  if (status === 'create_failed') {
    return '创建失败';
  }

  if (status === 'pending_destroy' || status === 'destroying') {
    return '销毁中';
  }

  if (status === 'destroy_failed') {
    return '销毁失败';
  }

  if (status === 'destroyed') {
    return '已销毁';
  }

  return status;
}

function getStatusTone(status: string) {
  if (status === 'running') {
    return 'is-published';
  }

  if (status === 'create_failed' || status === 'destroy_failed') {
    return 'is-danger';
  }

  return 'is-draft';
}

function getImageLabel(instance: RangeInstance) {
  return instance.singleInstanceConfig?.imageDisplayName?.trim() || '暂无';
}

function getSpecLabel(instance: RangeInstance) {
  const cpu = instance.singleInstanceConfig?.cpu;
  const memory = instance.singleInstanceConfig?.memory;

  if (!cpu || !memory) {
    return '暂无';
  }

  return `${cpu} 核 / ${memory} G`;
}

function getPublicIp(instance: RangeInstance) {
  return instance.accessEntry?.publicIp?.trim() || '暂无';
}

function readJobTimestamp(job: ProvisionJob | undefined, edge: 'start' | 'end') {
  if (!job) {
    return null;
  }

  if (edge === 'start') {
    return job.startedAt ?? job.finishedAt ?? null;
  }

  return job.finishedAt ?? job.startedAt ?? null;
}

function compareJobTimeAscending(left: ProvisionJob, right: ProvisionJob) {
  return String(left.startedAt ?? left.finishedAt ?? '').localeCompare(String(right.startedAt ?? right.finishedAt ?? ''));
}

function getAvailableActions(status: string): MenuAction[] {
  if (status === 'running') {
    return ['destroy', 'reboot', 'open-vnc', 'pack-image'];
  }

  if (status === 'destroy_failed') {
    return ['retry'];
  }

  if (status === 'create_failed') {
    return ['retry', 'delete-record'];
  }

  return [];
}

function getActionLabel(action: MenuAction, status: string) {
  if (action === 'delete-record') {
    return '删除记录';
  }

  if (action === 'destroy') {
    return '关闭实例';
  }

  if (action === 'retry') {
    return status === 'destroy_failed' ? '重试关闭' : '重试创建';
  }

  if (action === 'reboot') {
    return '重启实例';
  }

  if (action === 'open-vnc') {
    return '打开 VNC';
  }

  return '打包为镜像';
}

function buildPlatformImageOptionLabel(image: PlatformImageAsset) {
  return `${image.displayName} (${image.imageId})`;
}

function findPlatformImageAsset(query: string, images: PlatformImageAsset[]) {
  const normalized = query.trim();

  if (!normalized) {
    return null;
  }

  return (
    images.find((item) => buildPlatformImageOptionLabel(item) === normalized) ??
    images.find((item) => item.displayName === normalized) ??
    images.find((item) => item.imageId === normalized) ??
    null
  );
}

function buildDefaultDialogState(platformImages: PlatformImageAsset[]): CreateDialogState {
  const defaultImage = platformImages.find((item) => item.enabled) ?? platformImages[0] ?? null;

  return {
    name: '',
    hostName: '',
    platformImageQuery: defaultImage ? buildPlatformImageOptionLabel(defaultImage) : '',
    cpu: '2',
    memory: '2',
    systemDiskSize: '40',
    expiresAt: '',
    password: '',
    quantity: '1',
    remark: '',
  };
}

function SingleInstanceDialog({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="template-workbench-dialog-backdrop" role="presentation">
      <section className="template-workbench-dialog single-instance-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="template-workbench-dialog-header">
          <h2>{title}</h2>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SingleInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: SingleInstancesScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [listMode, setListMode] = useState<ListMode>('active');
  const [instances, setInstances] = useState<RangeInstance[]>([]);
  const [jobs, setJobs] = useState<ProvisionJob[]>([]);
  const [platformImages, setPlatformImages] = useState<PlatformImageAsset[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [menuInstanceId, setMenuInstanceId] = useState<string | null>(null);
  const [pendingActionInstanceId, setPendingActionInstanceId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateDialogState>(buildDefaultDialogState([]));
  const [instanceTypeAvailability, setInstanceTypeAvailability] = useState<InstanceTypeAvailabilitySnapshot | null>(null);
  const [createFormError, setCreateFormError] = useState<string | null>(null);
  const instanceTypeAvailabilityRequestRef = useRef(0);

  async function reloadSingleInstanceRows(token: string) {
    const [nextInstances, nextJobs] = await Promise.all([
      fetchSingleInstances(apiBaseUrl, token),
      fetchProvisionJobs(apiBaseUrl, token),
    ]);
    const singleInstances = nextInstances.filter((instance) => instance.instanceMode === 'single');

    setInstances(singleInstances);
    setJobs(nextJobs.filter((job) => singleInstances.some((instance) => instance.id === job.rangeInstanceId)));

    return singleInstances;
  }

  useEffect(() => {
    if (!session.isReady || !session.token) {
      return;
    }

    let isActive = true;

    void Promise.all([
      reloadSingleInstanceRows(session.token),
      fetchPlatformImages(apiBaseUrl, session.token),
    ])
      .then(([, nextImages]) => {
        if (!isActive) {
          return;
        }
        setPlatformImages(nextImages.items);
        setCreateForm((current) =>
          current.platformImageQuery ? current : buildDefaultDialogState(nextImages.items.filter((item) => item.enabled)),
        );
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('实例管理数据加载失败，请稍后重试。');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, session.isReady, session.token]);

  const jobsByInstanceId = useMemo(() => {
    return jobs.reduce<Map<string, ProvisionJob[]>>((map, job) => {
      const existing = map.get(job.rangeInstanceId) ?? [];
      existing.push(job);
      map.set(job.rangeInstanceId, existing);
      return map;
    }, new Map<string, ProvisionJob[]>());
  }, [jobs]);

  const lifecycleByInstanceId = useMemo(() => {
    return Array.from(jobsByInstanceId.entries()).reduce<
      Map<string, { createJob?: ProvisionJob; destroyJob?: ProvisionJob }>
    >((map, [instanceId, instanceJobs]) => {
      let createJob: ProvisionJob | undefined;
      let destroyJob: ProvisionJob | undefined;
      let retryPhase: 'create' | 'destroy' | null = null;

      for (const job of instanceJobs.slice().sort(compareJobTimeAscending)) {
        if (job.jobType === 'create') {
          retryPhase = 'create';

          if (job.status === 'succeeded') {
            createJob = job;
          }

          continue;
        }

        if (job.jobType === 'destroy') {
          retryPhase = 'destroy';

          if (job.status === 'succeeded') {
            destroyJob = job;
          }

          continue;
        }

        if (job.jobType === 'retry' && job.status === 'succeeded') {
          if (retryPhase === 'create') {
            createJob = job;
          }

          if (retryPhase === 'destroy') {
            destroyJob = job;
          }
        }
      }

      map.set(instanceId, {
        createJob,
        destroyJob,
      });
      return map;
    }, new Map<string, { createJob?: ProvisionJob; destroyJob?: ProvisionJob }>());
  }, [jobsByInstanceId]);

  const activeInstances = useMemo(
    () => instances.filter((instance) => instance.status !== 'destroyed'),
    [instances],
  );
  const historyInstances = useMemo(
    () => instances.filter((instance) => instance.status === 'destroyed'),
    [instances],
  );
  const enabledPlatformImages = useMemo(
    () => platformImages.filter((item) => item.enabled),
    [platformImages],
  );

  function updateCreateForm<K extends keyof CreateDialogState>(field: K, value: CreateDialogState[K]) {
    setCreateFormError(null);
    setCreateForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function openCreateDialog() {
    setCreateForm(buildDefaultDialogState(enabledPlatformImages));
    setCreateFormError(null);
    setIsCreateOpen(true);
  }

  useEffect(() => {
    if (!isCreateOpen) {
      setInstanceTypeAvailability(null);
      return;
    }

    if (!session.isReady || !session.token) {
      return;
    }

    const cpu = Number(createForm.cpu);
    const memory = Number(createForm.memory);

    if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) {
      setInstanceTypeAvailability(null);
      return;
    }

    let isActive = true;
    const requestId = instanceTypeAvailabilityRequestRef.current + 1;
    instanceTypeAvailabilityRequestRef.current = requestId;

    fetchInstanceTypeAvailability(apiBaseUrl, session.token, cpu, memory)
      .then((payload) => {
        if (!isActive || requestId !== instanceTypeAvailabilityRequestRef.current) {
          return;
        }

        setInstanceTypeAvailability(payload);
      })
      .catch((error) => {
        if (!isActive || requestId !== instanceTypeAvailabilityRequestRef.current) {
          return;
        }

        if (error instanceof AdminApiError && error.status === 401) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setInstanceTypeAvailability({
          cpu,
          memory,
          regionId: '',
          zoneId: '',
          exactAvailable: false,
          matches: [],
          warning: error instanceof Error ? `规格校验失败：${error.message}` : '规格校验失败，请稍后重试',
        });
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, createForm.cpu, createForm.memory, isCreateOpen, session.isReady, session.token]);

  async function handleCreateSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session.token) {
      return;
    }

    const selectedPlatformImage = findPlatformImageAsset(createForm.platformImageQuery, enabledPlatformImages);
    const cpu = Number(createForm.cpu);
    const memory = Number(createForm.memory);

    if (!selectedPlatformImage) {
      setCreateFormError('请先选择一个可用的平台镜像。');
      return;
    }

    if (
      !instanceTypeAvailability ||
      instanceTypeAvailability.cpu !== cpu ||
      instanceTypeAvailability.memory !== memory ||
      !instanceTypeAvailability.exactAvailable
    ) {
      setCreateFormError('当前规格未通过可售校验，请调整 CPU / 内存或稍后重试。');
      return;
    }

    const payload: SingleInstanceLaunchInput = {
      name: createForm.name.trim(),
      hostName: createForm.hostName.trim() || undefined,
      platformImageAssetId: selectedPlatformImage.id,
      cpu,
      memory,
      ...(createForm.systemDiskSize.trim() ? { systemDiskSize: Number(createForm.systemDiskSize) } : {}),
      expiresAt: new Date(createForm.expiresAt).toISOString(),
      password: createForm.password.trim() || undefined,
      quantity: Number(createForm.quantity),
      remark: createForm.remark.trim() || undefined,
      triggeredBy: 'admin',
    };

    setIsSubmitting(true);
    setCreateFormError(null);
    setErrorMessage(null);

    try {
      const result = await launchSingleInstances(apiBaseUrl, session.token, payload);
      setInstances((current) => [...result.instances, ...current.filter((item) => !result.instances.some((next) => next.id === item.id))]);
      setIsCreateOpen(false);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('创建实例失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAction(instance: RangeInstance, action: MenuAction) {
    if (!session.token) {
      return;
    }

    if (pendingActionInstanceId) {
      return;
    }

    setMenuInstanceId(null);
    setErrorMessage(null);
    setPendingActionInstanceId(instance.id);
    const openedWindow =
      action === 'open-vnc'
        ? window.open('', '_blank')
        : null;

    try {
      const vncWindow = action === 'open-vnc' ? openedWindow : null;
      if (action === 'open-vnc') {
        if (!vncWindow) {
          setErrorMessage('浏览器阻止了新窗口，请允许弹窗后重试。');
          return;
        }

        vncWindow.opener = null;
      }

      if (action === 'delete-record') {
        await deleteRangeInstance(apiBaseUrl, session.token, instance.id);
        await reloadSingleInstanceRows(session.token);
        return;
      }

      const result = await triggerSingleInstanceAction(apiBaseUrl, session.token, instance.id, action, {
        triggeredBy: 'admin',
        ...(action === 'pack-image' ? { displayName: `${instance.name ?? instance.id}-snapshot` } : {}),
      });

      if (action === 'open-vnc') {
        if (!vncWindow) {
          setErrorMessage('浏览器阻止了新窗口，请允许弹窗后重试。');
          return;
        }

        const vncUrl =
          result &&
          typeof result === 'object' &&
          'vncUrl' in result &&
          typeof (result as { vncUrl?: unknown }).vncUrl === 'string'
            ? (result as { vncUrl: string }).vncUrl.trim()
            : '';

        if (!vncUrl) {
          vncWindow.close();
          setErrorMessage('VNC 地址未返回，请稍后重试。');
          return;
        }

        vncWindow.location.href = vncUrl;
        return;
      }

      await reloadSingleInstanceRows(session.token);
    } catch (error: unknown) {
      openedWindow?.close();
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例操作失败，请稍后重试。');
    } finally {
      setPendingActionInstanceId(null);
    }
  }

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
        </section>
      </main>
    );
  }

  const visibleInstances = listMode === 'history' ? historyInstances : activeInstances;

  return (
    <div className="admin-screen admin-workbench-screen single-instance-screen">
      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section>
        <article className="admin-workbench-panel range-workbench-shell">
          <div className="template-workbench-list-header range-workbench-header">
            <div className="template-workbench-list-header-copy">
              <h2>实例管理</h2>
            </div>
          </div>

          <div className="template-workbench-controls range-workbench-controls">
            <div className="template-workbench-segmented range-workbench-segmented" role="tablist" aria-label="实例视图切换">
              <button type="button" aria-pressed={listMode === 'active'} onClick={() => setListMode('active')}>
                实例列表
              </button>
              <button type="button" aria-pressed={listMode === 'history'} onClick={() => setListMode('history')}>
                实例历史
              </button>
            </div>

            <button
              type="button"
              className="template-workbench-primary-action"
              onClick={openCreateDialog}
              disabled={!enabledPlatformImages.length}
            >
              创建实例
            </button>
          </div>
          {!enabledPlatformImages.length ? (
            <p className="admin-empty">请先前往镜像中心收录或启用至少一个平台镜像。</p>
          ) : null}

          {listMode === 'history' ? (
            <div className="single-instance-history-column-head">
              <div className="template-workbench-column-cell"><strong>实例名</strong></div>
              <div className="template-workbench-column-cell"><strong>创建人</strong></div>
              <div className="template-workbench-column-cell"><strong>镜像</strong></div>
              <div className="template-workbench-column-cell"><strong>规格</strong></div>
              <div className="template-workbench-column-cell"><strong>公网 IP</strong></div>
              <div className="template-workbench-column-cell"><strong>开启时间</strong></div>
              <div className="template-workbench-column-cell"><strong>回收时间</strong></div>
              <div className="template-workbench-column-cell"><strong>运行时长</strong></div>
              <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
            </div>
          ) : (
            <div className="single-instance-workbench-column-head">
              <div className="template-workbench-column-cell"><strong>实例名</strong></div>
              <div className="template-workbench-column-cell"><strong>创建人</strong></div>
              <div className="template-workbench-column-cell"><strong>镜像</strong></div>
              <div className="template-workbench-column-cell"><strong>规格</strong></div>
              <div className="template-workbench-column-cell"><strong>公网 IP</strong></div>
              <div className="template-workbench-column-cell"><strong>状态</strong></div>
              <div className="template-workbench-column-cell"><strong>创建时间</strong></div>
              <div className="template-workbench-column-cell"><strong>到期时间</strong></div>
              <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
            </div>
          )}

          {visibleInstances.length ? (
            <div className="range-workbench-rows">
              {visibleInstances.map((instance) => {
                const isHistory = listMode === 'history';
                const lifecycle = lifecycleByInstanceId.get(instance.id);
                const startedAt =
                  readJobTimestamp(lifecycle?.createJob, 'start') ??
                  instance.createdAt ??
                  null;
                const endedAt =
                  readJobTimestamp(lifecycle?.destroyJob, 'end') ??
                  null;
                const actions = getAvailableActions(instance.status);
                const isActionPending = pendingActionInstanceId === instance.id;
                return (
                  <article
                    key={instance.id}
                    className={
                      isHistory
                        ? `single-instance-history-row${menuInstanceId === instance.id ? ' is-menu-open' : ''}`
                        : `single-instance-workbench-row${menuInstanceId === instance.id ? ' is-menu-open' : ''}`
                    }
                  >
                    <div className="range-workbench-main">
                      <strong>{instance.name?.trim() || instance.id}</strong>
                    </div>
                    <div className="range-workbench-main">
                      <span>{instance.createdBy?.trim() || '暂无'}</span>
                    </div>
                    <div className="range-workbench-main">
                      <span>{getImageLabel(instance)}</span>
                    </div>
                    <div className="range-workbench-main">
                      <span>{getSpecLabel(instance)}</span>
                    </div>
                    <div className="range-workbench-main">
                      <span>{getPublicIp(instance)}</span>
                    </div>
                    {isHistory ? (
                      <>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(startedAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(endedAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDuration(startedAt, endedAt)}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="template-workbench-status">
                          <span className={`template-workbench-status-pill ${getStatusTone(instance.status)}`}>
                            {getStatusLabel(instance.status)}
                          </span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(instance.createdAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(instance.expiresAt)}</span>
                        </div>
                      </>
                    )}
                    <div className="template-workbench-row-menu range-workbench-actions workbench-action-cell">
                      {actions.length ? (
                        <>
                          <button
                            type="button"
                            disabled={isActionPending}
                            onClick={() => setMenuInstanceId((current) => (current === instance.id ? null : instance.id))}
                          >
                            更多操作
                          </button>
                          {menuInstanceId === instance.id ? (
                            <div className="template-workbench-action-menu">
                              {actions.map((action) => (
                                <button key={action} type="button" disabled={isActionPending} onClick={() => void handleAction(instance, action)}>
                                  {getActionLabel(action, instance.status)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="template-workbench-empty">
              <strong>{listMode === 'history' ? '暂无实例历史' : '暂无实例'}</strong>
            </div>
          )}
        </article>
      </section>

      {isCreateOpen ? (
        <SingleInstanceDialog title="创建实例">
          <form onSubmit={handleCreateSubmit}>
            <div className="template-workbench-dialog-grid single-instance-dialog-grid">
              <label>
                <span>实例名</span>
                <input aria-label="实例名" value={createForm.name} onChange={(event) => updateCreateForm('name', event.target.value)} required />
              </label>
              <label>
                <span>主机名</span>
                <input aria-label="主机名" value={createForm.hostName} onChange={(event) => updateCreateForm('hostName', event.target.value)} />
              </label>
              <label>
                <span>镜像</span>
                <input
                  aria-label="镜像"
                  list="single-instance-platform-images"
                  value={createForm.platformImageQuery}
                  onChange={(event) => updateCreateForm('platformImageQuery', event.target.value)}
                  placeholder="搜索或选择平台镜像"
                  disabled={!enabledPlatformImages.length}
                />
                <datalist id="single-instance-platform-images">
                  {enabledPlatformImages.map((item) => (
                    <option key={item.id} value={buildPlatformImageOptionLabel(item)} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>CPU</span>
                <input aria-label="CPU" type="number" min="1" value={createForm.cpu} onChange={(event) => updateCreateForm('cpu', event.target.value)} required />
              </label>
              <label>
                <span>内存</span>
                <input aria-label="内存" type="number" min="1" value={createForm.memory} onChange={(event) => updateCreateForm('memory', event.target.value)} required />
              </label>
              <label>
                <span>磁盘大小</span>
                <input
                  aria-label="磁盘大小"
                  type="number"
                  min="20"
                  value={createForm.systemDiskSize}
                  onChange={(event) => updateCreateForm('systemDiskSize', event.target.value)}
                />
              </label>
              <label>
                <span>到期时间</span>
                <input
                  aria-label="到期时间"
                  type="datetime-local"
                  value={createForm.expiresAt}
                  onChange={(event) => updateCreateForm('expiresAt', event.target.value)}
                  required
                />
              </label>
              <label>
                <span>密码</span>
                <input aria-label="密码" type="password" value={createForm.password} onChange={(event) => updateCreateForm('password', event.target.value)} />
              </label>
              <label>
                <span>启动实例数量</span>
                <input
                  aria-label="启动实例数量"
                  type="number"
                  min="1"
                  max="99"
                  value={createForm.quantity}
                  onChange={(event) => updateCreateForm('quantity', event.target.value)}
                  required
                />
              </label>
              <label className="full-span">
                <span>备注</span>
                <textarea aria-label="备注" value={createForm.remark} onChange={(event) => updateCreateForm('remark', event.target.value)} rows={3} />
              </label>
              {createFormError ? <p className="admin-error full-span">{createFormError}</p> : null}
              {!enabledPlatformImages.length ? (
                <p className="admin-empty full-span">请先前往镜像中心收录或启用平台镜像后，再创建实例。</p>
              ) : null}
              {instanceTypeAvailability && !instanceTypeAvailability.exactAvailable ? (
                <p className="admin-empty full-span">
                  {instanceTypeAvailability.warning ?? `默认可用区暂无 ${createForm.cpu} 核 / ${createForm.memory} G 的精确可售规格。`}
                </p>
              ) : null}
            </div>
            <div className="template-workbench-dialog-actions">
              <button type="submit" disabled={isSubmitting || !enabledPlatformImages.length}>
                确认创建
              </button>
              <button type="button" onClick={() => setIsCreateOpen(false)}>
                取消
              </button>
            </div>
          </form>
        </SingleInstanceDialog>
      ) : null}
    </div>
  );
}
