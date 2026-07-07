'use client';

import React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  buildScenarioTemplateSpecFromTopologyGraph,
  compileScenarioTemplateSpec,
} from '@aliyun-cyber-range/scenario-runtime';

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
  statusLabel: string;
  ipAddress?: string;
  specLabel?: string;
  typeLabel?: string;
  account?: string;
  password?: string;
  hostName?: string;
  imageName?: string;
  cpu?: number;
  memory?: number;
  subtitle?: string;
  cidr?: string;
  purpose?: string;
  routeRole?: string;
  egressType?: string;
  aclRuleCount?: number;
  dnatCount?: number;
  snatEnabled?: boolean;
  x?: number;
  y?: number;
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

function getStatusLabel(status: string) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'pending_create' || status === 'creating') {
    return '创建中';
  }

  if (status === 'pending_destroy' || status === 'destroying') {
    return '销毁中';
  }

  if (status === 'destroyed') {
    return '已销毁';
  }

  if (status === 'create_failed') {
    return '创建失败';
  }

  if (status === 'destroy_failed') {
    return '销毁失败';
  }

  return status;
}

function getTypeLabel(kind: string) {
  if (kind === 'ecs') {
    return '虚拟主机';
  }

  if (kind === 'switch') {
    return '交换机';
  }

  if (kind === 'router') {
    return '路由器';
  }

  return kind;
}

function readScenarioTemplateSpec(detail: RangeInstanceDetail | null) {
  const candidate =
    (detail?.draftScenarioTemplateSpec as Record<string, unknown> | null) ??
    (detail?.runtimeScenarioTemplateSpec as Record<string, unknown> | null) ??
    null;

  return candidate && typeof candidate === 'object' ? candidate : null;
}

function readHostSpec(detail: RangeInstanceDetail | null, nodeId: string) {
  const spec = readScenarioTemplateSpec(detail);
  const hosts = Array.isArray(spec?.hosts) ? (spec?.hosts as Array<Record<string, unknown>>) : [];

  return hosts.find((host) => host.key === nodeId) ?? null;
}

function readZoneSpec(detail: RangeInstanceDetail | null, zoneKey: string | undefined) {
  if (!zoneKey) {
    return null;
  }

  const spec = readScenarioTemplateSpec(detail);
  const zones = Array.isArray(spec?.networkZones) ? (spec?.networkZones as Array<Record<string, unknown>>) : [];

  return zones.find((zone) => zone.key === zoneKey) ?? null;
}

function readScenarioName(detail: RangeInstanceDetail | null) {
  const spec = readScenarioTemplateSpec(detail);
  const metadata = spec?.metadata;

  if (metadata && typeof metadata === 'object') {
    const name = (metadata as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }

  return detail?.templateNameSnapshot?.trim() || '未知场景';
}

function detectDefaultAccount(node: Record<string, unknown>) {
  const imageName = String(node.imageName ?? node.imageId ?? node.image ?? '').toLowerCase();
  return imageName.includes('windows') ? 'Administrator' : 'root';
}

function readNodeCredential(node: Record<string, unknown>) {
  return typeof node.password === 'string' && node.password.trim() ? node.password.trim() : '待回填';
}

function readWorkbenchNodesFromGraph(
  graph: Record<string, unknown> | null | undefined,
  detail: RangeInstanceDetail | null,
): WorkbenchNode[] {
  if (!graph || typeof graph !== 'object') {
    return [];
  }

  const nodes = graph.nodes;

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.flatMap((value) => {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const node = value as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id : '';
    const kind = readNodeKind(node);
    const hostSpec = readHostSpec(detail, id);
    const zoneKey =
      (typeof node.zoneKey === 'string' ? node.zoneKey : undefined) ??
      (hostSpec && typeof hostSpec.zoneKey === 'string' ? hostSpec.zoneKey : undefined);
    const zoneSpec = readZoneSpec(detail, zoneKey);
    const primaryNic =
      Array.isArray(node.nics) && node.nics[0] && typeof node.nics[0] === 'object'
        ? (node.nics[0] as Record<string, unknown>)
        : null;
    const ipAddress =
      (typeof primaryNic?.privateIp === 'string' && primaryNic.privateIp) ||
      (hostSpec && typeof hostSpec.primaryPrivateIp === 'string' ? hostSpec.primaryPrivateIp : undefined) ||
      (typeof node.privateIp === 'string' && node.privateIp) ||
      (kind === 'switch' && typeof node.cidr === 'string' ? node.cidr : undefined);

    if (!id) {
      return [];
    }

    return [
      {
        id,
        label: readNodeLabel(node),
        kind,
        statusLabel: getStatusLabel(detail?.status ?? 'unknown'),
        ipAddress,
        specLabel:
          kind === 'ecs'
            ? `${node.cpu ?? 0} 核 / ${node.memory ?? 0} G`
            : kind === 'switch'
              ? (typeof node.cidr === 'string' ? node.cidr : '网络节点')
              : 'VPC 路由',
        typeLabel: getTypeLabel(kind),
        account: kind === 'ecs' ? detectDefaultAccount(node) : '-',
        password: kind === 'ecs' ? readNodeCredential(node) : '-',
        hostName: typeof node.hostName === 'string' ? node.hostName : undefined,
        imageName: typeof node.imageName === 'string' ? node.imageName : typeof node.imageId === 'string' ? node.imageId : undefined,
        cpu: typeof node.cpu === 'number' ? node.cpu : undefined,
        memory: typeof node.memory === 'number' ? node.memory : undefined,
        subtitle:
          kind === 'ecs'
            ? ipAddress ?? '未配置私网IP'
            : kind === 'switch'
              ? (typeof node.cidr === 'string' ? node.cidr : '交换机')
              : 'VPC 根节点',
        cidr: typeof node.cidr === 'string' ? node.cidr : undefined,
        purpose:
          typeof node.purpose === 'string'
            ? node.purpose
            : zoneSpec && typeof zoneSpec.purpose === 'string'
              ? zoneSpec.purpose
              : undefined,
        routeRole: typeof node.routeRole === 'string' ? node.routeRole : undefined,
        egressType: typeof node.egressType === 'string' ? node.egressType : undefined,
        aclRuleCount: Array.isArray(node.aclRules) ? node.aclRules.length : 0,
        dnatCount:
          node.nat && typeof node.nat === 'object' && Array.isArray((node.nat as Record<string, unknown>).dnatMappings)
            ? ((node.nat as Record<string, unknown>).dnatMappings as unknown[]).length
            : 0,
        snatEnabled:
          node.nat && typeof node.nat === 'object' && typeof (node.nat as Record<string, unknown>).snatEnabled === 'boolean'
            ? ((node.nat as Record<string, unknown>).snatEnabled as boolean)
            : undefined,
        x:
          node.position && typeof node.position === 'object' && typeof (node.position as Record<string, unknown>).x === 'number'
            ? ((node.position as Record<string, unknown>).x as number)
            : undefined,
        y:
          node.position && typeof node.position === 'object' && typeof (node.position as Record<string, unknown>).y === 'number'
            ? ((node.position as Record<string, unknown>).y as number)
            : undefined,
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
      return readWorkbenchNodesFromGraph(
        (detail?.runtimeTopologyGraph as Record<string, unknown> | null) ?? null,
        detail,
      );
    }

    return readWorkbenchNodesFromGraph(draftGraph, detail);
  }, [detail, draftGraph]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );
  const canOperateInstance = detail?.status === 'running';

  const activeGraph = useMemo(() => {
    return (
      (detail?.draftTopologyGraph as Record<string, unknown> | null) ??
      (detail?.runtimeTopologyGraph as Record<string, unknown> | null) ??
      null
    );
  }, [detail]);

  const topologyEdges = useMemo(() => {
    if (!activeGraph || !Array.isArray(activeGraph.edges)) {
      return [];
    }

    return (activeGraph.edges as Array<Record<string, unknown>>).flatMap((edge) => {
      if (
        typeof edge.id === 'string' &&
        typeof edge.fromNodeId === 'string' &&
        typeof edge.toNodeId === 'string'
      ) {
        return [
          {
            id: edge.id,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
          },
        ];
      }

      return [];
    });
  }, [activeGraph]);

  useEffect(() => {
    if (!selectedNodeId && nodes.length > 0) {
      setSelectedNodeId(nodes[0].id);
    }
  }, [nodes, selectedNodeId]);

  async function handleSaveDraft() {
    if (!session.token || !detail || !draftGraph) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);

    try {
      const currentSpec = readScenarioTemplateSpec(detail);
      let nextScenarioTemplateSpec =
        (detail.draftScenarioTemplateSpec as Record<string, unknown> | null) ??
        (detail.runtimeScenarioTemplateSpec as Record<string, unknown> | null) ??
        {};
      let nextCompiledProvisionSpec =
        (detail.draftCompiledProvisionSpec as Record<string, unknown> | null) ??
        (detail.runtimeCompiledProvisionSpec as Record<string, unknown> | null) ??
        {};

      try {
        const metadata =
          currentSpec && typeof currentSpec.metadata === 'object'
            ? (currentSpec.metadata as {
                name?: string;
                slug?: string;
                version?: string;
                cloudProvider?: 'alibaba_cloud';
                iacType?: 'opentofu' | 'terraform';
              })
            : {};
        const rebuiltScenarioTemplateSpec = buildScenarioTemplateSpecFromTopologyGraph({
          topologyGraph: draftGraph as unknown as Parameters<
            typeof buildScenarioTemplateSpecFromTopologyGraph
          >[0]['topologyGraph'],
          metadata: {
            name: metadata.name ?? detail.name ?? 'instance-draft',
            slug: metadata.slug ?? detail.id,
            version: metadata.version ?? 'v1',
            cloudProvider: metadata.cloudProvider ?? 'alibaba_cloud',
            iacType: metadata.iacType ?? 'opentofu',
          },
          defaults: {
            vpcCidr:
              currentSpec &&
              currentSpec.topology &&
              typeof currentSpec.topology === 'object' &&
              typeof (currentSpec.topology as Record<string, unknown>).vpcCidr === 'string'
                ? ((currentSpec.topology as Record<string, unknown>).vpcCidr as string)
                : detail.resourceSummary?.topologySpec?.vpcCidr ?? '10.0.0.0/16',
          },
        });
        nextScenarioTemplateSpec = rebuiltScenarioTemplateSpec as unknown as Record<string, unknown>;
        nextCompiledProvisionSpec = compileScenarioTemplateSpec(rebuiltScenarioTemplateSpec) as unknown as Record<string, unknown>;
      } catch {
        // Fall back to the current runtime/draft spec when the draft graph is too incomplete to recompile.
      }

      const updated = await saveRangeInstanceDraft(apiBaseUrl, session.token, detail.id, {
        draftTopologyGraph: draftGraph,
        draftScenarioTemplateSpec: nextScenarioTemplateSpec,
        draftCompiledProvisionSpec: nextCompiledProvisionSpec,
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

  function handleEditedNodeFieldChange(
    field: 'label' | 'hostName' | 'imageName' | 'cpu' | 'memory' | 'ipAddress' | 'account' | 'password',
    value: string,
  ) {
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
            ? { ...(node.data as Record<string, unknown>) }
            : {};

        if (field === 'label') {
          nextData.label = value;
          return {
            ...node,
            label: value,
            instanceName: value,
            data: nextData,
          };
        }

        if (field === 'hostName') {
          return {
            ...node,
            hostName: value,
            data: nextData,
          };
        }

        if (field === 'imageName') {
          return {
            ...node,
            imageName: value,
            imageId: value,
            image: value,
            data: nextData,
          };
        }

        if (field === 'cpu') {
          const cpu = Number(value);
          return {
            ...node,
            cpu: Number.isFinite(cpu) ? cpu : node.cpu,
            data: nextData,
          };
        }

        if (field === 'memory') {
          const memory = Number(value);
          return {
            ...node,
            memory: Number.isFinite(memory) ? memory : node.memory,
            data: nextData,
          };
        }

        if (field === 'ipAddress') {
          const nextNics =
            Array.isArray(node.nics) && node.nics.length > 0
              ? (node.nics as Array<Record<string, unknown>>).map((nic, index) =>
                  index === 0
                    ? {
                        ...nic,
                        privateIp: value,
                      }
                    : nic,
                )
              : node.nics;

          return {
            ...node,
            privateIp: value,
            nics: nextNics,
            data: nextData,
          };
        }

        if (field === 'account') {
          return {
            ...node,
            account: value,
            data: nextData,
          };
        }

        if (field === 'password') {
          return {
            ...node,
            password: value,
            data: nextData,
          };
        }

        return node;
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
                <div className="range-instance-overview-item">
                  <span>实例名</span>
                  <strong>{detail.name?.trim() || detail.id}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>场景名称</span>
                  <strong>{readScenarioName(detail)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>当前状态</span>
                  <strong>{getStatusLabel(detail.status)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>创建人</span>
                  <strong>{detail.createdBy ?? 'admin'}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>创建时间</span>
                  <strong>{formatDateTime(detail.createdAt)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>公网IP</span>
                  <strong>{detail.accessEntry?.publicIp ?? '暂无'}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>到期时间</span>
                  <strong>{formatDateTime(detail.expiresAt)}</strong>
                </div>
                {!canOperateInstance ? (
                  <div className="range-instance-overview-item is-readonly">
                    <span>详情模式</span>
                    <strong>只读历史</strong>
                  </div>
                ) : null}
              </section>

              <div className="template-workbench-segmented" role="tablist" aria-label="实例详情视图切换">
                <button type="button" aria-pressed={activeTab === 'directory'} onClick={() => setActiveTab('directory')}>
                  节点目录
                </button>
                <button type="button" aria-pressed={activeTab === 'topology'} onClick={() => setActiveTab('topology')}>
                  拓扑结构
                </button>
              </div>

              {activeTab === 'topology' && canOperateInstance ? (
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
              ) : null}

              <div className="range-instance-detail-content">
                <div className="range-instance-detail-main">
                  {activeTab === 'directory' ? (
                    <RangeInstanceNodeDirectory
                      nodes={nodes.map((node) => ({
                        ...node,
                        createdBy: detail.createdBy ?? 'admin',
                        expiresAt: formatDateTime(detail.expiresAt),
                        createdAt: formatDateTime(detail.createdAt),
                      }))}
                      onNodeAction={handleNodeAction}
                      allowActions={canOperateInstance}
                    />
                  ) : (
                    <RangeInstanceTopologyWorkbench
                      nodes={nodes}
                      edges={topologyEdges}
                      onSelectNode={setSelectedNodeId}
                      selectedNodeId={selectedNodeId}
                    />
                  )}
                </div>

                {activeTab === 'topology' && selectedNode ? (
                  <RangeInstancePropertyPanel
                    selectedNode={selectedNode}
                    onEditedNodeFieldChange={handleEditedNodeFieldChange}
                    readOnly={!canOperateInstance}
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
