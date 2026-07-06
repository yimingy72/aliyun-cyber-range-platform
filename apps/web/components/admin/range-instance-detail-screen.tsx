'use client';

import React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AdminApiError, applyRangeInstanceDraft, fetchRangeInstanceDetail, runRangeInstanceNodeAction } from '../../lib/admin-api';
import type { RangeInstanceDetail } from '../../lib/admin-types';
import { RangeInstanceNodeDirectory } from './range-instance-node-directory';
import { RangeInstancePropertyPanel } from './range-instance-property-panel';
import { RangeInstanceTopologyWorkbench } from './range-instance-topology-workbench';
import { useAdminSession } from './use-admin-session';
import { discardRangeInstanceDraft, saveRangeInstanceDraft } from '../../lib/admin-api';

type RangeInstanceDetailScreenProps = {
  rangeId: string;
  apiBaseUrl?: string;
};

type WorkbenchTab = 'directory' | 'topology';

type WorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

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

function readNodeLabel(node: Record<string, unknown>) {
  if (typeof node.label === 'string' && node.label.trim()) {
    return node.label.trim();
  }

  const data = node.data;

  if (data && typeof data === 'object') {
    const label = (data as Record<string, unknown>).label;
    if (typeof label === 'string' && label.trim()) {
      return label.trim();
    }
  }

  return typeof node.id === 'string' ? node.id : 'unknown-node';
}

function readNodeKind(node: Record<string, unknown>) {
  return typeof node.kind === 'string' ? node.kind : 'unknown';
}

function readRuntimeNodes(detail: RangeInstanceDetail | null): WorkbenchNode[] {
  const runtimeGraph = detail?.runtimeTopologyGraph;

  if (!runtimeGraph || typeof runtimeGraph !== 'object') {
    return [];
  }

  const nodes = (runtimeGraph as Record<string, unknown>).nodes;

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.flatMap((value) => {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const node = value as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id : '';

    if (!id) {
      return [];
    }

    return [
      {
        id,
        label: readNodeLabel(node),
        kind: readNodeKind(node),
      },
    ];
  });
}

export function RangeInstanceDetailScreen({
  rangeId,
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: RangeInstanceDetailScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [detail, setDetail] = useState<RangeInstanceDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('directory');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draftGraph, setDraftGraph] = useState<Record<string, unknown> | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  useEffect(() => {
    if (!session.isReady || !session.token) {
      return;
    }

    let isActive = true;

    void fetchRangeInstanceDetail(apiBaseUrl, session.token, rangeId)
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setDetail(payload);
        setDraftGraph((payload.draftTopologyGraph as Record<string, unknown> | null) ?? (payload.runtimeTopologyGraph as Record<string, unknown> | null) ?? null);
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

        setErrorMessage('实例详情加载失败，请稍后重试。');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, rangeId, router, session]);

  const nodes = useMemo(() => {
    if (!draftGraph || typeof draftGraph !== 'object') {
      return readRuntimeNodes(detail);
    }

    const draftNodes = (draftGraph as Record<string, unknown>).nodes;

    if (!Array.isArray(draftNodes)) {
      return readRuntimeNodes(detail);
    }

    return draftNodes.flatMap((value) => {
      if (!value || typeof value !== 'object') {
        return [];
      }

      const node = value as Record<string, unknown>;
      const id = typeof node.id === 'string' ? node.id : '';

      if (!id) {
        return [];
      }

      return [
        {
          id,
          label: readNodeLabel(node),
          kind: readNodeKind(node),
        },
      ];
    });
  }, [detail, draftGraph]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  async function handleSaveDraft() {
    if (!session.token || !detail || !draftGraph) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);

    try {
      const updated = await saveRangeInstanceDraft(apiBaseUrl, session.token, detail.id, {
        draftTopologyGraph: draftGraph,
        draftScenarioTemplateSpec:
          (detail.draftScenarioTemplateSpec as Record<string, unknown> | null) ??
          (detail.runtimeScenarioTemplateSpec as Record<string, unknown> | null) ??
          {},
        draftCompiledProvisionSpec:
          (detail.draftCompiledProvisionSpec as Record<string, unknown> | null) ??
          (detail.runtimeCompiledProvisionSpec as Record<string, unknown> | null) ??
          {},
        draftUpdatedBy: 'admin',
      });

      setDetail(updated);
      setDraftGraph((updated.draftTopologyGraph as Record<string, unknown> | null) ?? draftGraph);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('保存变更草稿失败，请稍后重试。');
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handleDiscardDraft() {
    if (!session.token || !detail) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);

    try {
      const updated = await discardRangeInstanceDraft(apiBaseUrl, session.token, detail.id);
      setDetail(updated);
      setDraftGraph((updated.runtimeTopologyGraph as Record<string, unknown> | null) ?? null);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('放弃未应用修改失败，请稍后重试。');
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handleApplyDraft() {
    if (!session.token || !detail) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);

    try {
      await applyRangeInstanceDraft(apiBaseUrl, session.token, detail.id, 'admin');
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('应用变更失败，请稍后重试。');
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handleNodeAction(nodeId: string, action: 'stop' | 'reboot' | 'open-vnc' | 'pack-image') {
    if (!session.token || !detail) {
      return;
    }

    setErrorMessage(null);

    try {
      await runRangeInstanceNodeAction(apiBaseUrl, session.token, detail.id, nodeId, action, {
        ...(action === 'pack-image' ? { displayName: `${nodeId}-snapshot` } : {}),
      });
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('节点操作失败，请稍后重试。');
    }
  }

  function handleEditedNodeLabelChange(value: string) {
    if (!selectedNodeId || !draftGraph || typeof draftGraph !== 'object') {
      return;
    }

    const existingNodes = Array.isArray((draftGraph as Record<string, unknown>).nodes)
      ? ((draftGraph as Record<string, unknown>).nodes as unknown[])
      : [];

    setDraftGraph({
      ...draftGraph,
      nodes: existingNodes.map((valueItem) => {
        if (!valueItem || typeof valueItem !== 'object') {
          return valueItem;
        }

        const node = valueItem as Record<string, unknown>;

        if (node.id !== selectedNodeId) {
          return node;
        }

        const nextData =
          node.data && typeof node.data === 'object'
            ? { ...(node.data as Record<string, unknown>), label: value }
            : { label: value };

        return {
          ...node,
          label: value,
          data: nextData,
        };
      }),
    });
  }

  return (
    <main className="admin-screen range-instance-detail-screen">
      <section className="template-workbench-shell">
        <div className="template-workbench-list">
          <div className="template-workbench-list-header">
            <div className="template-workbench-list-header-copy">
              <h2>实例详情</h2>
              <p>{detail?.name?.trim() || rangeId}</p>
            </div>
          </div>

          {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

          {detail ? (
            <>
              <section className="range-instance-overview-grid">
                <span>实例名</span>
                <strong>{detail.name?.trim() || detail.id}</strong>
                <span>场景名称</span>
                <strong>{detail.templateNameSnapshot?.trim() || '未知场景'}</strong>
                <span>当前状态</span>
                <strong>{detail.status}</strong>
                <span>创建人</span>
                <strong>{detail.createdBy ?? 'admin'}</strong>
                <span>创建时间</span>
                <strong>{formatDateTime(detail.createdAt)}</strong>
                <span>公网IP</span>
                <strong>{detail.accessEntry?.publicIp ?? '暂无'}</strong>
                <span>到期时间</span>
                <strong>{formatDateTime(detail.expiresAt)}</strong>
              </section>

              <div className="template-workbench-segmented" role="tablist" aria-label="实例详情视图切换">
                <button type="button" aria-pressed={activeTab === 'directory'} onClick={() => setActiveTab('directory')}>
                  节点目录
                </button>
                <button type="button" aria-pressed={activeTab === 'topology'} onClick={() => setActiveTab('topology')}>
                  拓扑结构
                </button>
              </div>

              <div className="range-instance-workbench-actions">
                <button type="button" disabled={isSavingDraft} onClick={() => void handleSaveDraft()}>
                  保存变更草稿
                </button>
                <button type="button" disabled={isSavingDraft} onClick={() => void handleApplyDraft()}>
                  应用变更
                </button>
                <button type="button" disabled={isSavingDraft} onClick={() => void handleDiscardDraft()}>
                  放弃未应用修改
                </button>
              </div>

              <div className="range-instance-detail-content">
                <div className="range-instance-detail-main">
                  {activeTab === 'directory' ? (
                    <RangeInstanceNodeDirectory
                      nodes={nodes}
                      onSelectNode={setSelectedNodeId}
                      onNodeAction={handleNodeAction}
                    />
                  ) : (
                    <RangeInstanceTopologyWorkbench nodes={nodes} onSelectNode={setSelectedNodeId} />
                  )}
                </div>

                {selectedNode ? (
                  <RangeInstancePropertyPanel
                    selectedNodeLabel={selectedNode.label}
                    editedNodeLabel={selectedNode.label}
                    onEditedNodeLabelChange={handleEditedNodeLabelChange}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <div className="admin-workbench-empty">
              <p>正在加载实例详情...</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
