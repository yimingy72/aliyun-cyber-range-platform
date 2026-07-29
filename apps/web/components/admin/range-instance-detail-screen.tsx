'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  applyRangeInstanceDraft,
  fetchRangeInstanceDetail,
  runRangeInstanceNodeAction,
  saveRangeInstanceDraft,
  syncRangeInstanceTemplate,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { RangeInstanceDetail, RangeInstanceNodeActionResult } from '../../lib/admin-types';
import {
  findDuplicateDnatExternalPorts,
  isPhaseOneNodeKind,
  type ScenarioGraphDraft,
  type TemplateNode,
} from '../../lib/scenario-graph';
import { buildTopologyDraftPayload } from '../../lib/topology-draft-payload';
import { RangeInstanceNodeDirectory } from './range-instance-node-directory';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPageHeader } from './shared/admin-page-header';
import type { TemplateEdge } from './template-editor/template-editor-screen';
import { readTopologyViewport } from './template-editor/topology-flow-adapter';
import { useAdminSession } from './use-admin-session';

type RangeInstanceDetailScreenProps = {
  rangeId: string;
  apiBaseUrl?: string;
};

type WorkbenchTab = 'directory' | 'topology';
type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'reset' | 'pack-image';

function TopologyWorkspaceLoading() {
  return (
    <>
      <div className="range-instance-detail-main range-instance-topology-main" aria-busy="true">
        <div className="admin-workbench-empty">
          <p>正在加载拓扑...</p>
        </div>
      </div>

      <aside className="template-editor-panel template-property-panel" aria-busy="true">
        <div className="admin-section-header template-property-panel-header">
          <h2>属性面板</h2>
        </div>
      </aside>
    </>
  );
}

const RangeInstanceTopologyWorkspace = dynamic(
  () =>
    import('./range-instance-topology-workspace').then(
      ({ RangeInstanceTopologyWorkspace: Component }) => Component,
    ),
  {
    ssr: false,
    loading: TopologyWorkspaceLoading,
  },
);

type WorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  statusLabel: string;
  cloudStatus?: string;
  ipAddresses?: string[];
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

type PackImageDialogDraft = {
  nodeId: string;
  displayName: string;
  defaultHostName: string;
  defaultPassword: string;
  description: string;
};

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

function getCloudStatusLabel(status?: string | null) {
  if (status === 'Running') {
    return '运行中';
  }

  if (status === 'Starting') {
    return '开机中';
  }

  if (status === 'Stopping') {
    return '关机中';
  }

  if (status === 'Stopped') {
    return '已关机';
  }

  if (status === 'Rebooting') {
    return '重启中';
  }

  return null;
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

function formatNetworkRuleSummary(detail: RangeInstanceDetail | null) {
  if (detail?.resourceSummary?.mode !== 'opentofu') {
    return '暂无已下发网络规则';
  }

  const dnatCount = Object.keys(detail.resourceSummary.dnatEntryIds ?? {}).length;
  const snatCount = Object.keys(detail.resourceSummary.snatEntryIds ?? {}).length;

  return `DNAT 已下发 ${dnatCount} 条 / SNAT 已下发 ${snatCount} 条`;
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

function readPrivateIps(
  node: Record<string, unknown>,
  hostSpec: Record<string, unknown> | null,
): string[] {
  const privateIps: string[] = [];

  function addIp(value: unknown) {
    if (typeof value !== 'string') {
      return;
    }

    const ip = value.trim();

    if (ip && !privateIps.includes(ip)) {
      privateIps.push(ip);
    }
  }

  function addSecondaryNetworkInterfaces(value: unknown) {
    if (!Array.isArray(value)) {
      return;
    }

    value.forEach((networkInterface, index) => {
      if (!networkInterface || typeof networkInterface !== 'object') {
        return;
      }

      const nic = networkInterface as Record<string, unknown>;
      const deviceIndex = typeof nic.deviceIndex === 'number' ? nic.deviceIndex : index;

      if (deviceIndex !== 0) {
        addIp(nic.privateIp);
      }

      if (Array.isArray(nic.secondaryIps)) {
        nic.secondaryIps.forEach(addIp);
      }
    });
  }

  const primaryNic = Array.isArray(node.nics) ? node.nics[0] : null;
  addIp(primaryNic && typeof primaryNic === 'object' ? (primaryNic as Record<string, unknown>).privateIp : node.privateIp);
  addSecondaryNetworkInterfaces(node.nics);
  addSecondaryNetworkInterfaces(node.networkInterfaces);
  addSecondaryNetworkInterfaces(hostSpec?.networkInterfaces);

  if (privateIps.length === 0) {
    addIp(hostSpec?.primaryPrivateIp);
  }

  return privateIps;
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

function readNodeAccount(node: Record<string, unknown>, detail: RangeInstanceDetail | null, nodeId: string) {
  if (typeof node.account === 'string' && node.account.trim()) {
    return node.account.trim();
  }

  if (nodeId) {
    const runtimeAccount = detail?.runtimeCredentials?.[nodeId]?.username;
    if (typeof runtimeAccount === 'string' && runtimeAccount.trim()) {
      return runtimeAccount.trim();
    }
  }

  return detectDefaultAccount(node);
}

function readNodeCredential(
  node: Record<string, unknown>,
  detail: RangeInstanceDetail | null,
  nodeId: string,
) {
  if (typeof node.password === 'string' && node.password.trim()) {
    return node.password.trim();
  }

  if (nodeId) {
    const runtimePassword = detail?.runtimeCredentials?.[nodeId]?.password;
    if (typeof runtimePassword === 'string' && runtimePassword.trim()) {
      return runtimePassword.trim();
    }
  }

  return '';
}

function readDefaultPackImageName(nodeLabel: string) {
  const suffix = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  return `${nodeLabel || 'ecs'}-snapshot-${suffix}`;
}

function normalizeTopologyNode(value: Record<string, unknown>): TemplateNode | null {
  if (typeof value.id !== 'string' || !isPhaseOneNodeKind(value.kind)) {
    return null;
  }

  const position =
    value.position && typeof value.position === 'object'
      ? {
          x: typeof (value.position as Record<string, unknown>).x === 'number' ? ((value.position as Record<string, unknown>).x as number) : 0,
          y: typeof (value.position as Record<string, unknown>).y === 'number' ? ((value.position as Record<string, unknown>).y as number) : 0,
        }
      : undefined;

  if (value.kind === 'router') {
    return {
      id: value.id,
      kind: 'router',
      label: readNodeLabel(value),
      position,
      description: typeof value.description === 'string' ? value.description : '',
      routeRole: typeof value.routeRole === 'string' ? value.routeRole : 'root',
      egressType: typeof value.egressType === 'string' ? value.egressType : 'internet',
      bindEip: typeof value.bindEip === 'boolean' ? value.bindEip : false,
    };
  }

  if (value.kind === 'switch') {
    return {
      id: value.id,
      kind: 'switch',
      label: readNodeLabel(value),
      position,
      zoneKey: typeof value.zoneKey === 'string' ? value.zoneKey : value.id,
      cidr: typeof value.cidr === 'string' ? value.cidr : '10.0.0.0/24',
      purpose: typeof value.purpose === 'string' ? value.purpose : 'business-zone',
      description: typeof value.description === 'string' ? value.description : '',
      aclRules: Array.isArray(value.aclRules) ? (value.aclRules as any[]) : [],
      nat:
        value.nat && typeof value.nat === 'object'
          ? {
              snatEnabled: typeof (value.nat as Record<string, unknown>).snatEnabled === 'boolean'
                ? ((value.nat as Record<string, unknown>).snatEnabled as boolean)
                : false,
              dnatMappings: Array.isArray((value.nat as Record<string, unknown>).dnatMappings)
                ? (((value.nat as Record<string, unknown>).dnatMappings as unknown[]) as any[])
                : [],
            }
          : {
              snatEnabled: false,
              dnatMappings: [],
            },
    };
  }

  const imageName =
    typeof value.imageName === 'string'
      ? value.imageName
      : typeof value.image === 'string'
        ? value.image
        : typeof value.imageId === 'string'
          ? value.imageId
          : '';
  const imageId = typeof value.imageId === 'string' ? value.imageId : imageName;
  const defaultPrivateIp = typeof value.privateIp === 'string' ? value.privateIp : '';
  const normalizedNics = Array.isArray(value.nics)
    ? ((value.nics as unknown[]) as any[])
    : defaultPrivateIp
      ? [
          {
            id: `${value.id}-nic-1`,
            switchId: '',
            privateIp: defaultPrivateIp,
            secondaryIps: [],
            securityGroupRules: [],
          },
        ]
      : [];

  return {
    id: value.id,
    kind: 'ecs',
    label: readNodeLabel(value),
    position,
    zoneKey: typeof value.zoneKey === 'string' ? value.zoneKey : '',
    role: typeof value.role === 'string' ? value.role : 'host',
    privateIp: defaultPrivateIp,
    customPassword: typeof value.customPassword === 'string' ? value.customPassword : undefined,
    exposePublic: typeof value.exposePublic === 'boolean' ? value.exposePublic : false,
    image: imageName,
    instanceName: typeof value.instanceName === 'string' ? value.instanceName : readNodeLabel(value),
    hostName: typeof value.hostName === 'string' ? value.hostName : '',
    imageName,
    imageId,
    cpu: typeof value.cpu === 'number' ? value.cpu : 1,
    memory: typeof value.memory === 'number' ? value.memory : 2,
    instanceType: typeof value.instanceType === 'string' ? value.instanceType : undefined,
    description: typeof value.description === 'string' ? value.description : '',
    bootPriority: typeof value.bootPriority === 'number' ? value.bootPriority : 1,
    bootWaitSeconds: typeof value.bootWaitSeconds === 'number' ? value.bootWaitSeconds : 0,
    dnatMappings: Array.isArray(value.dnatMappings) ? ((value.dnatMappings as unknown[]) as any[]) : [],
    networkInterfaces: Array.isArray(value.networkInterfaces) ? ((value.networkInterfaces as unknown[]) as any[]) : [],
    portGroups: Array.isArray(value.portGroups) ? ((value.portGroups as unknown[]) as any[]) : [],
    nics: normalizedNics,
    initScript: typeof value.initScript === 'string' ? value.initScript : '',
    imageStrategy:
      value.imageStrategy && typeof value.imageStrategy === 'object'
        ? ((value.imageStrategy as Record<string, unknown>) as any)
        : {
            mode: 'fixed',
            imageId,
          },
    instanceTypeStrategy:
      value.instanceTypeStrategy && typeof value.instanceTypeStrategy === 'object'
        ? ((value.instanceTypeStrategy as Record<string, unknown>) as any)
        : {
            mode: 'auto',
            preferredInstanceTypes: [],
          },
  };
}

function readTopologyGraphDraft(graph: Record<string, unknown> | null | undefined): ScenarioGraphDraft | null {
  if (!graph || typeof graph !== 'object') {
    return null;
  }

  const nodes = Array.isArray(graph.nodes)
    ? (graph.nodes as Array<Record<string, unknown>>).flatMap((node) => {
        if (!node || typeof node !== 'object') {
          return [];
        }

        const normalized = normalizeTopologyNode(node);
        return normalized ? [normalized] : [];
      })
    : [];

  const edges = Array.isArray(graph.edges)
    ? (graph.edges as Array<Record<string, unknown>>).flatMap((edge) => {
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
              relationType: 'manual' as const,
              label: typeof edge.label === 'string' ? edge.label : undefined,
            },
          ];
        }

        return [];
      })
    : [];

  return {
    schemaVersion: typeof graph.schemaVersion === 'string' ? graph.schemaVersion : '1',
    nodes,
    edges,
  };
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
    const ipAddresses =
      kind === 'ecs'
        ? readPrivateIps(node, hostSpec)
        : kind === 'switch' && typeof node.cidr === 'string'
          ? [node.cidr]
          : [];
    const cloudStatus = detail?.nodeStatuses?.[id] ?? undefined;
    const statusLabel = kind === 'ecs' ? getCloudStatusLabel(cloudStatus) ?? getStatusLabel(detail?.status ?? 'unknown') : getStatusLabel(detail?.status ?? 'unknown');

    if (!id) {
      return [];
    }

    return [
      {
        id,
        label: readNodeLabel(node),
        kind,
        statusLabel,
        cloudStatus,
        ipAddresses,
        specLabel:
          kind === 'ecs'
            ? `${node.cpu ?? 0} 核 / ${node.memory ?? 0} G`
            : kind === 'switch'
              ? (typeof node.cidr === 'string' ? node.cidr : '网络节点')
              : 'VPC 路由',
        typeLabel: getTypeLabel(kind),
        account: kind === 'ecs' ? readNodeAccount(node, detail, id) : '-',
        password: kind === 'ecs' ? readNodeCredential(node, detail, id) : '-',
        hostName: typeof node.hostName === 'string' ? node.hostName : undefined,
        imageName: typeof node.imageName === 'string' ? node.imageName : typeof node.imageId === 'string' ? node.imageId : undefined,
        cpu: typeof node.cpu === 'number' ? node.cpu : undefined,
        memory: typeof node.memory === 'number' ? node.memory : undefined,
        subtitle:
          kind === 'ecs'
            ? ipAddresses.join(', ') || '未配置私网IP'
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
  apiBaseUrl = 'http://localhost:3001',
}: RangeInstanceDetailScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [detail, setDetail] = useState<RangeInstanceDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('directory');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draftGraph, setDraftGraph] = useState<Record<string, unknown> | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSyncingTemplate, setIsSyncingTemplate] = useState(false);
  const [pendingNodeAction, setPendingNodeAction] = useState<{
    nodeId: string;
    action: NodeActionName;
  } | null>(null);
  const [nodeStatusOverrides, setNodeStatusOverrides] = useState<Record<string, string>>({});
  const [packImageDialog, setPackImageDialog] = useState<PackImageDialogDraft | null>(null);

  async function reloadDetailSnapshot() {
    if (!session.token) {
      return null;
    }

    const payload = await fetchRangeInstanceDetail(apiBaseUrl, session.token, rangeId);
    setDetail(payload);
    setDraftGraph(
      (payload.draftTopologyGraph as Record<string, unknown> | null) ??
        (payload.runtimeTopologyGraph as Record<string, unknown> | null) ??
        null,
    );
    return payload;
  }

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

        if (isUnauthorizedAdminError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('实例详情加载失败，请稍后重试。');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, rangeId, router, session.isReady, session.token]);

  const topologyDraft = useMemo(() => {
    return (
      readTopologyGraphDraft(draftGraph) ??
      readTopologyGraphDraft((detail?.runtimeTopologyGraph as Record<string, unknown> | null) ?? null)
    );
  }, [detail, draftGraph]);

  const directoryNodes = useMemo(() => {
    if (!draftGraph || typeof draftGraph !== 'object') {
      return readWorkbenchNodesFromGraph(
        (detail?.runtimeTopologyGraph as Record<string, unknown> | null) ?? null,
        detail,
      );
    }

    return readWorkbenchNodesFromGraph(draftGraph, detail);
  }, [detail, draftGraph]);
  const displayedDirectoryNodes = useMemo(
    () =>
      directoryNodes.map((node) => ({
        ...node,
        statusLabel: nodeStatusOverrides[node.id] ?? node.statusLabel,
      })),
    [directoryNodes, nodeStatusOverrides],
  );

  const topologyNodes = topologyDraft?.nodes ?? [];
  const topologyEdges = useMemo<TemplateEdge[]>(() => topologyDraft?.edges ?? [], [topologyDraft]);
  const selectedTopologyNode = useMemo(
    () => topologyNodes.find((node) => node.id === selectedNodeId) ?? null,
    [topologyNodes, selectedNodeId],
  );
  const canOperateInstance = detail?.status === 'running';
  const linkedSwitchIdsByHostId = useMemo(() => {
    const nodeById = new Map(topologyNodes.map((node) => [node.id, node]));
    const nextMap: Record<string, string[]> = {};

    for (const edge of topologyEdges) {
      const sourceNode = nodeById.get(edge.fromNodeId);
      const targetNode = nodeById.get(edge.toNodeId);

      if (sourceNode?.kind !== 'switch' || targetNode?.kind !== 'ecs') {
        continue;
      }

      nextMap[targetNode.id] = [...(nextMap[targetNode.id] ?? []), sourceNode.id];
    }

    return nextMap;
  }, [topologyEdges, topologyNodes]);
  const topologyStatusMessage = !canOperateInstance
    ? '历史实例只读预览。'
    : detail?.draftUpdatedAt
      ? '存在未应用草稿变更，可继续编辑并保存。'
      : '点击节点后可在右侧编辑属性。';

  useEffect(() => {
    if (!selectedNodeId && topologyNodes.length > 0) {
      setSelectedNodeId(topologyNodes[0].id);
    }
  }, [topologyNodes, selectedNodeId]);

  async function persistDraftChanges() {
    if (!session.token || !detail || !draftGraph) {
      return null;
    }

    setErrorMessage(null);

    const duplicateDnatPorts = findDuplicateDnatExternalPorts(topologyDraft?.nodes ?? []);

    if (duplicateDnatPorts.length > 0) {
      const conflict = duplicateDnatPorts[0]!;
      setErrorMessage(
        `DNAT 公网端口 ${conflict.externalPort} 重复（${conflict.usages
          .map((usage) => `${usage.switchLabel} 的 DNAT 规则 ${usage.mappingIndex + 1}`)
          .join('、')}），请修改后再保存或应用。`,
      );
      return null;
    }

    try {
      const currentSpec = readScenarioTemplateSpec(detail);
      let nextTopologyGraph = draftGraph;
      let nextTopologySpec =
        (detail.draftTopologySpec as Record<string, unknown> | null) ??
        {};
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
        const primaryVpcCidr =
          currentSpec &&
          currentSpec.topology &&
          typeof currentSpec.topology === 'object' &&
          typeof (currentSpec.topology as Record<string, unknown>).vpcCidr === 'string'
            ? ((currentSpec.topology as Record<string, unknown>).vpcCidr as string)
            : detail.resourceSummary?.topologySpec?.vpcCidr ?? '10.0.0.0/16';
        const payload = buildTopologyDraftPayload({
          graph: draftGraph as unknown as ScenarioGraphDraft,
          metadata: {
            name: metadata.name ?? detail.name ?? 'instance-draft',
            slug: metadata.slug ?? detail.id,
            version: metadata.version ?? 'v1',
            cloudProvider: metadata.cloudProvider ?? 'alibaba_cloud',
            iacType: metadata.iacType ?? 'opentofu',
            modulePathOrRef: detail.templateModulePathSnapshot ?? 'runtime/range-instance',
            primaryVpcCidr,
          },
          viewport: readTopologyViewport(draftGraph.viewport),
        });
        nextTopologyGraph = payload.topologyGraph;
        nextTopologySpec = payload.topologySpec;
        nextScenarioTemplateSpec = payload.scenarioTemplateSpec;
        nextCompiledProvisionSpec = payload.compiledProvisionSpec;
      } catch {
        // Fall back to the current runtime/draft spec when the draft graph is too incomplete to recompile.
      }

      const updated = await saveRangeInstanceDraft(apiBaseUrl, session.token, detail.id, {
        draftTopologyGraph: nextTopologyGraph,
        draftTopologySpec: nextTopologySpec,
        draftScenarioTemplateSpec: nextScenarioTemplateSpec,
        draftCompiledProvisionSpec: nextCompiledProvisionSpec,
        expectedDraftRevision: detail.draftRevision ?? 0,
      });

      setDetail(updated);
      setDraftGraph((updated.draftTopologyGraph as Record<string, unknown> | null) ?? nextTopologyGraph);
      return updated;
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return null;
      }

      setErrorMessage('保存变更草稿失败，请稍后重试。');
      return null;
    }
  }

  async function handleApplyDraft() {
    if (!session.token || !detail) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const saved = await persistDraftChanges();

      if (!saved) {
        return;
      }

      const expectedDraftRevision = saved.draftRevision;

      if (
        typeof expectedDraftRevision !== 'number' ||
        !Number.isInteger(expectedDraftRevision) ||
        expectedDraftRevision < 1
      ) {
        throw new Error('Saved range instance draft revision is unavailable');
      }

      await applyRangeInstanceDraft(apiBaseUrl, session.token, detail.id, expectedDraftRevision);
      setSuccessMessage('实例配置变更已提交应用。');
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('应用变更失败，请稍后重试。');
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handleSaveDraft() {
    if (!session.token || !detail) {
      return;
    }

    setIsSavingDraft(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const saved = await persistDraftChanges();

      if (!saved) {
        return;
      }

      setSuccessMessage('实例草稿已保存。');
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handleSyncTemplate() {
    if (!session.token || !detail) {
      return;
    }

    if (
      typeof window !== 'undefined' &&
      !window.confirm('将当前实例拓扑与配置覆盖为模板当前草稿。该操作不会自动创建或修改实例，是否继续？')
    ) {
      return;
    }

    setIsSyncingTemplate(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const saved = await persistDraftChanges();

      if (!saved) {
        return;
      }

      await syncRangeInstanceTemplate(apiBaseUrl, session.token, detail.id);
      setSuccessMessage('当前实例拓扑已更新到模板草稿。');
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '更新编排拓扑失败，请稍后重试。');
    } finally {
      setIsSyncingTemplate(false);
    }
  }

  function openPackImageDialog(nodeId: string) {
    const node =
      displayedDirectoryNodes.find((item) => item.id === nodeId) ??
      topologyNodes.find((item) => item.id === nodeId) ??
      null;

    if (!node) {
      return;
    }

    setPackImageDialog({
      nodeId,
      displayName: readDefaultPackImageName(node.label),
      defaultHostName: node.kind === 'ecs' ? (node.hostName ?? '') : '',
      defaultPassword: '',
      description: '',
    });
  }

  async function handleConfirmPackImage() {
    if (!session.token || !detail || !packImageDialog) {
      return;
    }

    setPendingNodeAction({
      nodeId: packImageDialog.nodeId,
      action: 'pack-image',
    });
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const result = await runRangeInstanceNodeAction(apiBaseUrl, session.token, detail.id, packImageDialog.nodeId, 'pack-image', {
        displayName: packImageDialog.displayName,
        defaultHostName: packImageDialog.defaultHostName,
        defaultPassword: packImageDialog.defaultPassword,
        description: packImageDialog.description,
      });

      setPackImageDialog(null);
      setSuccessMessage(
        result.imageReady
          ? `镜像打包完成，已保存到我的镜像：${result.platformImageAsset?.displayName ?? packImageDialog.displayName}`
          : `镜像打包任务已提交，镜像可用后会出现在我的镜像：${packImageDialog.displayName}`,
      );
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '二次打包镜像失败，请稍后重试。');
    } finally {
      setPendingNodeAction(null);
    }
  }

  async function handleNodeAction(nodeId: string, action: NodeActionName) {
    if (!session.token || !detail) {
      return;
    }

    if (action === 'pack-image') {
      openPackImageDialog(nodeId);
      return;
    }

    if (action === 'reset') {
      setErrorMessage('重置功能对应主机系统盘恢复到当前镜像初始状态，本轮先不执行该危险动作。');
      setSuccessMessage(null);
      return;
    }

    setPendingNodeAction({ nodeId, action });
    setErrorMessage(null);
    setSuccessMessage(null);
    const vncWindow = action === 'open-vnc' ? window.open('', '_blank') : null;

    try {
      if (action === 'open-vnc') {
        if (!vncWindow) {
          throw new Error('浏览器阻止了新窗口，请允许弹窗后重试。');
        }

        vncWindow.opener = null;
      }

      const result = await runRangeInstanceNodeAction(apiBaseUrl, session.token, detail.id, nodeId, action, {});

      if (action === 'start') {
        setNodeStatusOverrides((current) => ({
          ...current,
          [nodeId]: 'Starting',
        }));
        setSuccessMessage('开机指令已提交。');
      }

      if (action === 'stop') {
        setNodeStatusOverrides((current) => ({
          ...current,
          [nodeId]: 'Stopping',
        }));
        setSuccessMessage('关机指令已提交。');
      }

      if (action === 'reboot') {
        setNodeStatusOverrides((current) => ({
          ...current,
          [nodeId]: 'Rebooting',
        }));
        setSuccessMessage('重启指令已提交。');
      }

      if (action === 'open-vnc') {
        const nextUrl = result.webTerminalUrl ?? result.vncUrl ?? null;

        if (!nextUrl) {
          throw new Error('当前未获取到可用的 VNC 访问地址。');
        }

        vncWindow!.location.href = nextUrl;
        setSuccessMessage('VNC 页面已在新标签页打开。');
      }

      if (action === 'start' || action === 'stop' || action === 'reboot') {
        window.setTimeout(() => {
          void reloadDetailSnapshot().then((payload) => {
            if (!payload?.nodeStatuses?.[nodeId]) {
              return;
            }

            setNodeStatusOverrides((current) => ({
              ...current,
              [nodeId]: payload.nodeStatuses?.[nodeId] ?? current[nodeId],
            }));
          }).catch(() => undefined);
        }, 2500);
      }
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      vncWindow?.close();
      setErrorMessage(error instanceof Error ? error.message : '节点操作失败，请稍后重试。');
    } finally {
      setPendingNodeAction(null);
    }
  }

  function updateDraftTopologyNode(nodeId: string, updater: (node: TemplateNode) => TemplateNode) {
    if (!canOperateInstance || !draftGraph || typeof draftGraph !== 'object') {
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

        if (node.id !== nodeId || !isPhaseOneNodeKind(node.kind)) {
          return node;
        }

        const nextNode = updater(normalizeTopologyNode(node) ?? (node as unknown as TemplateNode));
        const synchronizedNode =
          nextNode.kind === 'ecs'
            ? {
                ...nextNode,
                privateIp: nextNode.nics?.[0]?.privateIp?.trim() || nextNode.privateIp.trim(),
              }
            : nextNode;
        const nextData =
          node.data && typeof node.data === 'object'
            ? {
                ...(node.data as Record<string, unknown>),
                label: synchronizedNode.label,
              }
            : {
                label: synchronizedNode.label,
              };

        return {
          ...node,
          ...synchronizedNode,
          data: nextData,
        };
      }),
    });
  }

  function handleUpdateTopologyNode(nodeId: string, nextNode: TemplateNode) {
    updateDraftTopologyNode(nodeId, () => nextNode);
  }

  function handleMoveTopologyNode(nodeId: string, position: { x: number; y: number }) {
    updateDraftTopologyNode(nodeId, (node) => ({
      ...node,
      position,
    }));
  }

  return (
    <main className="admin-screen range-instance-detail-screen">
      <section className="admin-workbench-surface range-instance-detail-workbench">
        <AdminPageHeader
          description="查看实例运行状态、节点目录与拓扑编排。"
          title="实例详情"
        />

        {errorMessage ? <p className="mt-4 text-sm text-destructive" role="alert">{errorMessage}</p> : null}
        {successMessage ? <p className="mt-4 text-sm text-emerald-700" role="status">{successMessage}</p> : null}

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
                  <strong>{formatAdminDateTime(detail.createdAt)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>到期时间</span>
                  <strong>{formatAdminDateTime(detail.expiresAt)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>公网IP（DNAT IP）</span>
                  <strong>{detail.accessEntry?.publicIp ?? '暂无'}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>网络规则</span>
                  <strong>{formatNetworkRuleSummary(detail)}</strong>
                </div>
                {!canOperateInstance ? (
                  <div className="range-instance-overview-item is-readonly">
                    <span>详情模式</span>
                    <strong>只读历史</strong>
                  </div>
                ) : null}
            </section>

            <div className="range-instance-detail-toolbar">
              <Tabs onValueChange={(value) => setActiveTab(value as WorkbenchTab)} value={activeTab}>
                <TabsList aria-label="实例详情视图切换" variant="line">
                  <TabsTrigger value="directory">
                    节点目录
                  </TabsTrigger>
                  <TabsTrigger value="topology">
                    拓扑结构
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {activeTab === 'topology' && canOperateInstance ? (
                <div className="range-instance-workbench-actions">
                  <Button
                    disabled={isSavingDraft || isSyncingTemplate}
                    onClick={() => void handleSaveDraft()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                      {isSavingDraft ? '处理中...' : '保存草稿'}
                  </Button>
                  <Button
                    disabled={isSavingDraft || isSyncingTemplate}
                    onClick={() => void handleApplyDraft()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                      {isSavingDraft ? '处理中...' : '应用变更'}
                  </Button>
                  <Button
                    disabled={isSavingDraft || isSyncingTemplate}
                    onClick={() => void handleSyncTemplate()}
                    size="sm"
                    type="button"
                  >
                      {isSyncingTemplate ? '处理中...' : '更新编排拓扑'}
                  </Button>
                </div>
              ) : null}
            </div>

            <div
              className={
                activeTab === 'directory'
                  ? 'range-instance-detail-content is-directory'
                  : 'range-instance-detail-content is-topology'
              }
            >
              {activeTab === 'directory' ? (
                <div className="range-instance-detail-main">
                  <RangeInstanceNodeDirectory
                    nodes={displayedDirectoryNodes.map((node) => ({
                      ...node,
                      createdBy: detail.createdBy ?? 'admin',
                      expiresAt: formatAdminDateTime(detail.expiresAt),
                      createdAt: formatAdminDateTime(detail.createdAt),
                    }))}
                    onNodeAction={handleNodeAction}
                    allowActions={canOperateInstance}
                    pendingAction={pendingNodeAction}
                  />
                </div>
              ) : (
                <RangeInstanceTopologyWorkspace
                  topologyGraph={draftGraph}
                  nodes={topologyNodes}
                  edges={topologyEdges}
                  selectedNodeId={selectedNodeId}
                  selectedNode={selectedTopologyNode}
                  linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
                  canOperateInstance={canOperateInstance}
                  runtimeNodeStatus={selectedTopologyNode ? detail?.nodeStatuses?.[selectedTopologyNode.id] ?? null : null}
                  statusMessage={topologyStatusMessage}
                  onSelectNode={setSelectedNodeId}
                  onMoveNode={handleMoveTopologyNode}
                  onUpdateNode={handleUpdateTopologyNode}
                />
              )}
            </div>
          </>
        ) : (
          <div className="admin-workbench-empty">
            <p>正在加载实例详情...</p>
          </div>
        )}
      </section>

      {packImageDialog ? (
        <AdminDialog
          footer={
            <>
              <Button disabled={pendingNodeAction?.action === 'pack-image'} type="button" variant="outline" onClick={() => setPackImageDialog(null)}>
                取消
              </Button>
              <Button
                disabled={pendingNodeAction?.action === 'pack-image' || packImageDialog.displayName.trim().length === 0}
                type="button"
                onClick={() => void handleConfirmPackImage()}
              >
                {pendingNodeAction?.action === 'pack-image' ? '处理中...' : '确认打包'}
              </Button>
            </>
          }
          open
          pending={pendingNodeAction?.action === 'pack-image'}
          size="wide"
          title="二次打包镜像"
          onOpenChange={(open) => !open && setPackImageDialog(null)}
        >
            <div className="template-workbench-dialog-grid">
              <label>
                <span>镜像名</span>
                <input
                  autoFocus
                  aria-label="镜像名"
                  value={packImageDialog.displayName}
                  onChange={(event) =>
                    setPackImageDialog((current) =>
                      current
                        ? {
                            ...current,
                            displayName: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label>
                <span>默认主机名</span>
                <input
                  aria-label="默认主机名"
                  placeholder="留空则使用当前主机名"
                  value={packImageDialog.defaultHostName}
                  onChange={(event) =>
                    setPackImageDialog((current) =>
                      current
                        ? {
                            ...current,
                            defaultHostName: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label>
                <span>默认密码</span>
                <input
                  aria-label="默认密码"
                  placeholder="留空则随机生成"
                  value={packImageDialog.defaultPassword}
                  onChange={(event) =>
                    setPackImageDialog((current) =>
                      current
                        ? {
                            ...current,
                            defaultPassword: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label>
                <span>镜像备注</span>
                <input
                  aria-label="镜像备注"
                  placeholder="选填"
                  value={packImageDialog.description}
                  onChange={(event) =>
                    setPackImageDialog((current) =>
                      current
                        ? {
                            ...current,
                            description: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
            </div>
        </AdminDialog>
      ) : null}
    </main>
  );
}
