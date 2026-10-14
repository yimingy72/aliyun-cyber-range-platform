'use client';

import React from 'react';
import { defaultSwitchCidr as readDefaultSwitchCidr, nextAvailableGraphId } from '@aliyun-cyber-range/scenario-runtime';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { CloudReleaseSummary } from './shared/cloud-release-status';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  applyRangeInstanceDraft,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  fetchProvisionJobDetail,
  fetchRangeInstanceDetail,
  runRangeInstanceNodeAction,
  saveRangeInstanceDraft,
  previewRangeInstanceDraft,
  saveRangeInstanceAsTemplate,
  triggerRangeAction,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { tencentImageError, verifiedTencentInstanceTypes } from '@/lib/cloud-execution-policy';
import { readCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  RangeInstanceDetail,
  RangeInstanceChangePreview,
  RangeRecoverySummary,
} from '../../lib/admin-types';
import { resolvePreferredInstanceTypes } from '../../lib/instance-type-catalog';
import {
  findDuplicateDnatExternalPorts,
  isPhaseOneNodeKind,
  type EcsTemplateNode,
  type ScenarioGraphDraft,
  type SwitchTemplateNode,
  type TemplateNode,
} from '../../lib/scenario-graph';
import { nextAvailableSwitchCidr, reconcileHostNicConnections } from '../../lib/scenario-graph-linking';
import { readHostDns } from '../../lib/host-dns';
import { buildTemplateImageOsHints, buildTopologyDraftPayload } from '../../lib/topology-draft-payload';
import { RangeInstanceNodeDirectory, type RangeNodeDnsVerification } from './range-instance-node-directory';
import { RangeInstanceDetailBodySkeleton, RangeInstanceTopologyLoading } from './range-instance-detail-loading';
import { AsyncContentState } from './shared/async-content-state';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPageHeader } from './shared/admin-page-header';
import { RangeChangePreviewDialog } from './range-change-preview-dialog';
import { ConfirmActionDialog } from './shared/confirm-action-dialog';
import { Input } from '@/components/ui/input';
import type { TemplateEdge } from './template-editor/template-editor-screen';
import { readTopologyViewport, writeTopologyViewport } from './template-editor/topology-flow-adapter';
import {
  createTopologyHistory,
  pushTopologySnapshot,
  redoTopology,
  undoTopology,
  type TopologyHistory,
} from './template-editor/topology-flow-history';
import { layoutTopology } from './template-editor/topology-flow-layout';
import type {
  TopologySelection,
  TopologySnapshot,
  TopologyViewport,
} from './template-editor/topology-flow-types';
import { useAdminSession } from './use-admin-session';

type RangeInstanceDetailScreenProps = {
  rangeId: string;
  apiBaseUrl?: string;
};

type WorkbenchTab = 'directory' | 'topology';
type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'reset' | 'pack-image' | 'verify-dns';
type DraftTopologyGraph = ScenarioGraphDraft & { viewport?: TopologyViewport };

const INSTANCE_TOPOLOGY_SCHEMA_VERSION = '2.0.0';

let topologyWorkspaceRequest: Promise<typeof import('./range-instance-topology-workspace')['RangeInstanceTopologyWorkspace']> | null = null;

export function preloadRangeInstanceTopologyWorkspace() {
  if (!topologyWorkspaceRequest) {
    topologyWorkspaceRequest = import('./range-instance-topology-workspace')
      .then(({ RangeInstanceTopologyWorkspace: Component }) => Component)
      .catch((error) => {
        topologyWorkspaceRequest = null;
        throw error;
      });
  }
  return topologyWorkspaceRequest;
}

const RangeInstanceTopologyWorkspace = dynamic(
  preloadRangeInstanceTopologyWorkspace,
  {
    ssr: false,
    loading: RangeInstanceTopologyLoading,
  },
);

type WorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  statusLabel: string;
  cloudStatus?: string;
  dns?: EcsTemplateNode['dns'];
  dnsVerification?: RangeNodeDnsVerification;
  ipAddresses?: string[];
  publicEntry?: { address: string; ports: string[] };
  subnetCidrs?: string[];
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

function readRecoveryCategoryLabel(category: RangeRecoverySummary['category']) {
  switch (category) {
    case 'capacity':
      return '云容量';
    case 'quota':
      return '云配额';
    case 'credentials':
      return '凭据/权限';
    case 'provider_setup':
      return '云账号配置';
    case 'template_blueprint':
      return '模板定义';
    default:
      return '未分类';
  }
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

function hasSameTopologySelection(left: TopologySelection, right: TopologySelection) {
  if (left.nodeIds.length !== right.nodeIds.length || left.edgeIds.length !== right.edgeIds.length) {
    return false;
  }

  const leftNodeIds = new Set(left.nodeIds);
  const leftEdgeIds = new Set(left.edgeIds);

  return right.nodeIds.every((nodeId) => leftNodeIds.has(nodeId))
    && right.edgeIds.every((edgeId) => leftEdgeIds.has(edgeId));
}

function readDefaultNodeLabel(kind: TemplateNode['kind'], ordinal: number) {
  if (kind === 'router') {
    return 'Router';
  }

  return kind === 'switch' ? `交换机 ${ordinal}` : `ECS ${ordinal}`;
}

function createNodePosition(kind: TemplateNode['kind'], ordinal: number) {
  const columnX = kind === 'router' ? 120 : kind === 'switch' ? 360 : 620;
  const rowOffset = Math.floor(Math.max(ordinal - 1, 0) / 3) * 150;
  const staggerOffset = ((Math.max(ordinal - 1, 0) % 3) - 1) * 24;

  return {
    x: columnX,
    y: 180 + rowOffset + staggerOffset,
  };
}

function createDefaultSwitchNode(id: string, label: string, ordinal: number): SwitchTemplateNode {
  return {
    id,
    kind: 'switch',
    label,
    position: createNodePosition('switch', ordinal),
    zoneKey: `zone-${ordinal}`,
    cidr: readDefaultSwitchCidr(ordinal),
    purpose: 'business-zone',
    description: '',
    aclRules: [],
    nat: {
      snatEnabled: false,
      dnatMappings: [],
    },
  };
}

function createDefaultEcsNode(id: string, label: string, ordinal: number, provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud'): EcsTemplateNode {
  const preferredInstanceTypes = provider === 'tencent_cloud' ? [] : resolvePreferredInstanceTypes(2, 2);

  return {
    id,
    kind: 'ecs',
    label,
    position: createNodePosition('ecs', ordinal),
    instanceName: label,
    hostName: `ecs-${ordinal}`,
    zoneKey: 'core',
    role: 'host',
    privateIp: '',
    customPassword: '',
    exposePublic: false,
    image: '',
    imageName: '',
    imageId: '',
    cpu: 2,
    memory: 2,
    description: '',
    bootPriority: 1,
    bootWaitSeconds: 0,
    dnatMappings: [],
    networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
    portGroups: [],
    nics: [{
      id: `${id}-nic-1`,
      switchId: '',
      privateIp: '',
      secondaryIps: [],
      securityGroupRules: [],
    }],
    initScript: '',
    imageStrategy: { mode: 'fixed' },
    instanceType: preferredInstanceTypes[0],
    instanceTypeStrategy: preferredInstanceTypes.length > 0
      ? { mode: 'prefer-list', preferredInstanceTypes: [...preferredInstanceTypes] }
      : { mode: 'auto', preferredInstanceTypes: [] },
  };
}

function syncHostNicsWithLinkedSwitch(hostNode: EcsTemplateNode, switchNode: SwitchTemplateNode): EcsTemplateNode {
  const nics = hostNode.nics && hostNode.nics.length > 0
    ? hostNode.nics
    : [{
        id: `${hostNode.id}-nic-1`,
        switchId: '',
        privateIp: '',
        secondaryIps: [],
        securityGroupRules: [],
      }];
  const linkedNicIndex = nics.findIndex((nic) => nic.switchId === switchNode.id);

  if (linkedNicIndex >= 0) {
    return linkedNicIndex === 0 && hostNode.zoneKey !== switchNode.zoneKey
      ? { ...hostNode, zoneKey: switchNode.zoneKey }
      : hostNode;
  }

  const emptyNicIndex = nics.findIndex((nic) => !nic.switchId);

  if (emptyNicIndex >= 0) {
    return {
      ...hostNode,
      ...(emptyNicIndex === 0 ? { zoneKey: switchNode.zoneKey } : {}),
      nics: nics.map((nic, index) => index === emptyNicIndex ? { ...nic, switchId: switchNode.id } : nic),
    };
  }

  return {
    ...hostNode,
    nics: [
      ...nics,
      {
        id: nextAvailableGraphId(`${hostNode.id}-nic`, nics.map((nic) => nic.id)),
        switchId: switchNode.id,
        privateIp: '',
        secondaryIps: [],
        securityGroupRules: [],
      },
    ],
  };
}

function cleanupNodeReferencesAfterDeletion(nodes: TemplateNode[], deletedNode: TemplateNode) {
  return nodes.map((node) => {
    if (deletedNode.kind === 'switch' && node.kind === 'ecs') {
      return {
        ...node,
        nics: (node.nics ?? []).map((nic) => nic.switchId === deletedNode.id ? { ...nic, switchId: '' } : nic),
      } satisfies TemplateNode;
    }

    if (deletedNode.kind === 'ecs' && node.kind === 'switch') {
      return {
        ...node,
        nat: {
          snatEnabled: node.nat?.snatEnabled ?? false,
          dnatMappings: (node.nat?.dnatMappings ?? []).filter((mapping) => mapping.targetHostId !== deletedNode.id),
        },
      } satisfies TemplateNode;
    }

    return node;
  });
}

function cleanupEdgeReferencesAfterDeletion(nodes: TemplateNode[], edge: TemplateEdge) {
  const sourceNode = nodes.find((node) => node.id === edge.fromNodeId) ?? null;
  const targetNode = nodes.find((node) => node.id === edge.toNodeId) ?? null;
  const switchNode = sourceNode?.kind === 'switch' ? sourceNode : targetNode?.kind === 'switch' ? targetNode : null;
  const hostNode = sourceNode?.kind === 'ecs' ? sourceNode : targetNode?.kind === 'ecs' ? targetNode : null;

  if (!switchNode || !hostNode) {
    return nodes;
  }

  return nodes.map((node) =>
    node.id === hostNode.id && node.kind === 'ecs'
      ? {
          ...node,
          nics: (node.nics ?? []).map((nic) => nic.switchId === switchNode.id ? { ...nic, switchId: '' } : nic),
        }
      : node,
  );
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
    platformImageAssetId: typeof value.platformImageAssetId === 'string' ? value.platformImageAssetId : undefined,
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
    dns: readHostDns(value.dns),
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
    ...(typeof value.account === 'string' ? { account: value.account } : {}),
    ...(typeof value.password === 'string' ? { password: value.password } : {}),
  } as EcsTemplateNode;
}

function restoreDeployedHostDefinitions(nodes: TemplateNode[], runtimeGraph: Record<string, unknown> | null | undefined): TemplateNode[] {
  const deployedNodes = (Array.isArray(runtimeGraph?.nodes) ? runtimeGraph.nodes : []) as TemplateNode[];
  const deployed = new Map(deployedNodes.filter((node) => node.kind === 'ecs').map((node) => [node.id, node]));
  return nodes.map((node) => {
    const original = deployed.get(node.id);
    if (node.kind !== 'ecs' || original?.kind !== 'ecs') return node;
    return { ...original, ...(node.position ? { position: node.position } : {}),
      ...(original.nics ? { nics: original.nics.map((nic) => {
        const edited = node.nics?.find((current) => current.id === nic.id);
        return { ...nic, ...(edited ? { securityGroupRules: edited.securityGroupRules,
          ...(edited.securityGroupRulesMode !== undefined ? { securityGroupRulesMode: edited.securityGroupRulesMode } : {}),
        } : {}) };
      }) } : {}),
    };
  });
}

function readTopologyGraphDraft(graph: Record<string, unknown> | null | undefined): DraftTopologyGraph | null {
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

  return writeTopologyViewport({
    schemaVersion: typeof graph.schemaVersion === 'string' ? graph.schemaVersion : INSTANCE_TOPOLOGY_SCHEMA_VERSION,
    nodes,
    edges,
  }, readTopologyViewport(graph.viewport));
}

function readDirectoryNetwork(nodeId: string, graph: Record<string, unknown>, detail: RangeInstanceDetail | null) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes as Array<Record<string, unknown>> : [];
  const node = nodes.find((item) => item.id === nodeId);
  const switches = nodes.filter((item) => item.kind === 'switch');
  const switchIds = new Set<string>();
  for (const nic of Array.isArray(node?.nics) ? node.nics : []) {
    if (typeof nic.switchId === 'string') switchIds.add(nic.switchId);
  }
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (edge.toNodeId === nodeId && typeof edge.fromNodeId === 'string') switchIds.add(edge.fromNodeId);
    if (edge.fromNodeId === nodeId && typeof edge.toNodeId === 'string') switchIds.add(edge.toNodeId);
  }
  const host = readHostSpec(detail, nodeId);
  const zoneKeys = new Set([node?.zoneKey, host?.zoneKey]);
  const linkedSwitches = switches.filter((item) => switchIds.has(String(item.id)));
  const subnetCidrs = (linkedSwitches.length ? linkedSwitches : switches.filter((item) => item.zoneKey && zoneKeys.has(item.zoneKey)))
    .flatMap((item) => typeof item.cidr === 'string' ? [item.cidr] : []);
  if (subnetCidrs.length === 0) {
    for (const nic of Array.isArray(host?.networkInterfaces) ? host.networkInterfaces : []) {
      const zone = readZoneSpec(detail, nic.zoneKey);
      if (typeof zone?.cidr === 'string') subnetCidrs.push(zone.cidr);
    }
    for (const zoneKey of zoneKeys) {
      const zone = readZoneSpec(detail, typeof zoneKey === 'string' ? zoneKey : undefined);
      if (typeof zone?.cidr === 'string') subnetCidrs.push(zone.cidr);
    }
  }

  // Directory entry points reflect the deployed runtime, not an unapplied local draft.
  const compiled = detail?.runtimeCompiledProvisionSpec;
  const runtimeNodes = Array.isArray(detail?.runtimeTopologyGraph?.nodes)
    ? detail.runtimeTopologyGraph.nodes as Array<Record<string, unknown>> : [];
  const mappings = Array.isArray(compiled?.dnatEntries) ? (compiled.dnatEntries as Array<Record<string, unknown>>).filter((entry) => entry.hostKey === nodeId)
    : runtimeNodes.flatMap((item) => {
      const nat = item.nat && typeof item.nat === 'object' ? item.nat as Record<string, unknown> : null;
      return item.kind === 'switch' && Array.isArray(nat?.dnatMappings)
        ? (nat.dnatMappings as Array<Record<string, unknown>>).filter((mapping) => mapping.targetHostId === nodeId) : [];
    });
  const deployedIds = detail?.resourceSummary?.dnatEntryIds;
  const ports = mappings.filter((mapping) =>
    typeof mapping.externalPort === 'number' && Number.isInteger(mapping.externalPort) && mapping.externalPort > 0 && mapping.externalPort <= 65535 &&
    typeof mapping.internalPort === 'number' && Number.isInteger(mapping.internalPort) && mapping.internalPort > 0 && mapping.internalPort <= 65535 &&
    (mapping.protocol === 'tcp' || mapping.protocol === 'udp') &&
    (deployedIds == null || Boolean(deployedIds[`dnat-${nodeId}-${mapping.protocol}-${mapping.externalPort}`])),
  ).map((mapping) => `${String(mapping.protocol).toUpperCase()} ${mapping.externalPort} → ${mapping.internalPort}`);
  const address = detail?.accessEntry?.publicIp?.trim();
  return {
    subnetCidrs: [...new Set(subnetCidrs)],
    publicEntry: address && ports.length > 0 ? { address, ports: [...new Set(ports)] } : undefined,
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
    const deployedNodes = Array.isArray(detail?.runtimeTopologyGraph?.nodes) ? detail.runtimeTopologyGraph.nodes as Array<Record<string, unknown>> : [];
    const deployedNode = deployedNodes.find((item) => item.id === id);
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
        ...(kind === 'ecs' ? { dns: readHostDns(deployedNode?.dns), dnsVerification: detail?.dnsVerification?.[id] } : {}),
        ipAddresses,
        ...(kind === 'ecs' ? readDirectoryNetwork(id, graph, detail) : {}),
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
  const workspace = useCloudWorkspace()?.workspace;
  const screenCache = useAdminScreenCache();
  const isPageActive = useAdminRouteIsActive(`/admin/ranges/${rangeId}`);
  const resourceKey = `range-instance-detail:${rangeId}:${session.profile?.id ?? 'current-session'}:${session.profile?.role ?? ''}`;
  const identityKey = `${apiBaseUrl}\u0000${session.profile?.id ?? 'current-session'}\u0000${session.profile?.role ?? ''}\u0000${rangeId}\u0000${workspace?.id ?? readCloudWorkspaceSelection() ?? ''}`;
  const scopeKey = `${identityKey}\u0000${session.token}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const cachedDetail = screenCache?.read<RangeInstanceDetail>(apiBaseUrl, session.token, resourceKey);
  const [detailState, setDetailState] = useState(() => ({ scope: identityKey, data: cachedDetail?.data ?? null }));
  const detail = session.isReady && session.token && detailState.scope === identityKey ? detailState.data : null;
  function setDetail(next: React.SetStateAction<RangeInstanceDetail | null>) {
    if (scopeRef.current !== scopeKey) return;
    setDetailState((current) => ({ scope: identityKey, data: typeof next === 'function'
      ? next(current.scope === identityKey ? current.data : null) : next }));
  }
  const detailRequestRef = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isRefreshingDetail, setIsRefreshingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('directory');
  const [selection, setSelection] = useState<TopologySelection>({ nodeIds: [], edgeIds: [] });
  const [draftGraph, setDraftGraph] = useState<Record<string, unknown> | null>(() => cachedDetail?.data.draftTopologyGraph ?? cachedDetail?.data.runtimeTopologyGraph ?? null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isCopyingTemplate, setIsCopyingTemplate] = useState(false);
  const [isTemplateCopyDialogOpen, setIsTemplateCopyDialogOpen] = useState(false);
  const [templateCopyName, setTemplateCopyName] = useState('');
  const [templateCopyDescription, setTemplateCopyDescription] = useState('');
  const [changePreview, setChangePreview] = useState<RangeInstanceChangePreview | null>(null);
  const copyRequestRef = useRef<{ scope: string; graph: string; name: string; description: string; revision: number; key: string } | null>(null);
  const [platformImageAssets, setPlatformImageAssets] = useState<PlatformImageAsset[]>([]);
  const [instanceTypeAvailability, setInstanceTypeAvailability] = useState<InstanceTypeAvailabilitySnapshot | null>(null);
  const [pendingNodeAction, setPendingNodeAction] = useState<{
    nodeId: string;
    action: NodeActionName;
  } | null>(null);
  const [nodeStatusOverrides, setNodeStatusOverrides] = useState<Record<string, string>>({});
  const [packImageDialog, setPackImageDialog] = useState<PackImageDialogDraft | null>(null);
  const historyRef = useRef<TopologyHistory | null>(null);
  const persistedSnapshotRef = useRef('');
  const loadedRangeIdRef = useRef(rangeId);
  const [trackedUpdateJobId, setTrackedUpdateJobId] = useState<string | null>(null);
  const [pendingRecoveryTrigger, setPendingRecoveryTrigger] = useState<'retry' | 'destroy' | null>(null);
  const [isRecoverySubmitting, setIsRecoverySubmitting] = useState(false);
  const [pendingRecoveryLookup, setPendingRecoveryLookup] = useState<{ previousJobId: string | null } | null>(null);
  const recoveryTriggeredJobsRef = useRef<Set<string>>(new Set());
  const [, setHistoryState] = useState<TopologyHistory | null>(null);
  const instanceTypeAvailabilityRequestRef = useRef(0);
  useEffect(() => {
    setChangePreview(null); setIsTemplateCopyDialogOpen(false); copyRequestRef.current = null;
    setPendingRecoveryTrigger(null); setIsRecoverySubmitting(false);
    setPendingRecoveryLookup(null); recoveryTriggeredJobsRef.current.clear();
  }, [identityKey]);

  useEffect(() => {
    if (isPageActive && detail?.id) void preloadRangeInstanceTopologyWorkspace().catch(() => undefined);
  }, [detail?.id, isPageActive]);

  function replaceTopologyDraft(nextGraph: Record<string, unknown> | null) {
    const parsed = readTopologyGraphDraft(nextGraph);

    if (!parsed) {
      historyRef.current = null;
      setHistoryState(null);
      setDraftGraph(nextGraph);
      setSelection({ nodeIds: [], edgeIds: [] });
      return;
    }

    const snapshot: TopologySnapshot = {
      nodes: parsed.nodes,
      edges: parsed.edges,
      viewport: readTopologyViewport(parsed.viewport),
    };
    historyRef.current = createTopologyHistory(snapshot);
    persistedSnapshotRef.current = JSON.stringify(snapshot);
    setHistoryState(historyRef.current);
    setChangePreview(null);
    setDraftGraph(writeTopologyViewport({
      schemaVersion: parsed.schemaVersion,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    }, snapshot.viewport));
    setSelection({ nodeIds: [], edgeIds: [] });
  }

  function receiveDetailSnapshot(payload: RangeInstanceDetail) {
    if (scopeRef.current !== scopeKey || payload.id !== rangeId) return;
    const hasLocalChanges = loadedRangeIdRef.current === rangeId && historyRef.current !== null &&
      JSON.stringify(historyRef.current.present) !== persistedSnapshotRef.current;

    setDetail((current) => hasLocalChanges && current
      ? { ...payload, draftRevision: current.draftRevision }
      : payload);
    setNodeStatusOverrides({});
    if (!hasLocalChanges) {
      replaceTopologyDraft(payload.draftTopologyGraph ?? payload.runtimeTopologyGraph ?? null);
    }
    loadedRangeIdRef.current = rangeId;
  }

  async function reloadDetailSnapshot() {
    if (!session.token || scopeRef.current !== scopeKey) {
      return null;
    }

    const request = ++detailRequestRef.current;
    screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
    const payload = await (screenCache?.load(apiBaseUrl, session.token, resourceKey,
      () => fetchRangeInstanceDetail(apiBaseUrl, session.token!, rangeId)) ?? fetchRangeInstanceDetail(apiBaseUrl, session.token, rangeId));
    if (request !== detailRequestRef.current || scopeRef.current !== scopeKey) return null;
    receiveDetailSnapshot(payload);
    return payload;
  }

  useEffect(() => {
    if (!isPageActive || !session.isReady || !session.token) {
      return;
    }

    let isActive = true;
    const request = ++detailRequestRef.current;
    const cached = screenCache?.read<RangeInstanceDetail>(apiBaseUrl, session.token, resourceKey);
    setErrorMessage(null);
    if (detailState.scope !== identityKey) {
      replaceTopologyDraft(null);
      loadedRangeIdRef.current = '';
      setDetail(null);
      setTrackedUpdateJobId(null);
      setPendingRecoveryTrigger(null);
      setIsRecoverySubmitting(false);
      setPendingRecoveryLookup(null);
      setPackImageDialog(null);
      setIsTemplateCopyDialogOpen(false);
      setPendingNodeAction(null);
      setSuccessMessage(null);
      setIsSavingDraft(false);
      setIsCopyingTemplate(false);
    }
    if (cached) {
      receiveDetailSnapshot(cached.data);
      setTrackedUpdateJobId(cached.data.lastJobId ?? null);
    }
    setIsRefreshingDetail(Boolean(cached && !cached.isFresh));
    const load = () => fetchRangeInstanceDetail(apiBaseUrl, session.token!, rangeId);
    void (screenCache?.load(apiBaseUrl, session.token, resourceKey, load, { force: loadAttempt > 0 }) ?? load())
      .then((payload) => {
        if (!isActive || request !== detailRequestRef.current || scopeRef.current !== scopeKey) {
          return;
        }

        receiveDetailSnapshot(payload);
        setTrackedUpdateJobId(payload.lastJobId ?? null);
      })
      .catch((error: unknown) => {
        if (!isActive || request !== detailRequestRef.current || scopeRef.current !== scopeKey) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('实例详情加载失败，请稍后重试。');
      }).finally(() => {
        if (isActive && request === detailRequestRef.current) setIsRefreshingDetail(false);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, isPageActive, loadAttempt, rangeId, router, screenCache, session.isReady, session.token, session.profile?.id, session.profile?.role, identityKey]);

  useEffect(() => {
    if (!isPageActive || !session.token || !pendingRecoveryLookup) return;
    let isActive = true;
    let timer: number | undefined;
    const previousJobId = pendingRecoveryLookup.previousJobId;

    async function refreshRecoveryResult() {
      try {
        const payload = await reloadDetailSnapshot();
        if (!isActive) return;
        if (payload) {
          const inFlight = ['pending_create', 'creating', 'pending_destroy', 'destroying'].includes(payload.status);
          if (payload.lastJobId && (payload.lastJobId !== previousJobId || inFlight)) {
            recoveryTriggeredJobsRef.current.add(payload.lastJobId);
            setTrackedUpdateJobId(payload.lastJobId);
            setPendingRecoveryLookup(null);
            setErrorMessage(null);
            return;
          }
          if (!inFlight) {
            setPendingRecoveryLookup(null);
            setTrackedUpdateJobId(null);
            const failed = payload.status === 'create_failed' || payload.status === 'destroy_failed';
            setErrorMessage(failed ? '未发现新的恢复任务，已刷新当前状态；请确认后再操作。' : null);
            setSuccessMessage(failed ? null : '实例状态已更新。');
            return;
          }
        }
      } catch (error) {
        if (!isActive) return;
        if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); return; }
        setErrorMessage('恢复操作结果未确认，状态查询失败，正在重试。');
      }
      if (isActive) timer = window.setTimeout(() => void refreshRecoveryResult(), 2000);
    }

    void refreshRecoveryResult();
    return () => { isActive = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [apiBaseUrl, isPageActive, rangeId, router, screenCache, session.token, pendingRecoveryLookup, scopeKey]);

  useEffect(() => {
    if (!isPageActive || !session.token || !trackedUpdateJobId || pendingRecoveryLookup) {
      return;
    }

    let isActive = true;
    let timer: number | undefined;
    const token = session.token;
    const jobId = trackedUpdateJobId;
    const detailStatus = detail?.status ?? '';

    async function refreshUpdateJob() {
      try {
        const { job } = await fetchProvisionJobDetail(apiBaseUrl, token, jobId);
        if (!isActive) return;
        // Restored lastJobId values that are neither updates nor in-flight lifecycle
        // jobs must not keep the tracker (or surface stale messages) alive.
        const inFlightLifecycle = ['pending_create', 'creating', 'pending_destroy', 'destroying'].includes(detailStatus);
        if (job.jobType !== 'update' && !inFlightLifecycle && !recoveryTriggeredJobsRef.current.has(jobId)) {
          setTrackedUpdateJobId(null);
          return;
        }

        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          screenCache?.invalidate(apiBaseUrl, token, 'range-instances:');
          // Sequence-guarded reload: an older detail response must never overwrite the
          // fresher terminal snapshot. Tracking only stops after the refresh resolves so
          // a failed refresh keeps polling and never swallows the terminal message.
          const payload = await reloadDetailSnapshot();
          if (!isActive) return;
          if (!payload) {
            timer = window.setTimeout(() => void refreshUpdateJob(), 2000);
            return;
          }
          setTrackedUpdateJobId(null);
          recoveryTriggeredJobsRef.current.delete(jobId);
          if (job.jobType === 'update') {
            setSuccessMessage(job.status === 'succeeded' ? '实例配置变更已应用。' : null);
            setErrorMessage(job.status === 'succeeded' ? null : [job.errorSummary || '实例配置变更未完成，请检查任务。', payload.status === 'destroy_failed' ? '部分云变更可能已生效，资源尚未确认全部回收；请查看任务并执行回收。' : ''].filter(Boolean).join(' '));
          } else {
            setSuccessMessage(job.status === 'succeeded' ? '任务已完成，实例状态已更新。' : null);
            setErrorMessage(job.status === 'succeeded' ? null : [job.errorSummary || '任务未完成，请查看任务详情后重试。', payload.status === 'destroy_failed' ? '部分云变更可能已生效，资源尚未确认全部回收；请查看任务并执行回收。' : ''].filter(Boolean).join(' '));
          }
          return;
        }
        if (job.jobType === 'update') {
          setErrorMessage(null);
          setSuccessMessage('实例配置变更正在应用。');
        }
      } catch (error) {
        if (!isActive) return;
        if (isUnauthorizedAdminError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }
        setErrorMessage('任务状态刷新失败，正在重试。');
      }
      if (isActive) timer = window.setTimeout(() => void refreshUpdateJob(), 2000);
    }

    void refreshUpdateJob();
    return () => {
      isActive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiBaseUrl, isPageActive, rangeId, router, screenCache, session.token, trackedUpdateJobId, pendingRecoveryLookup, scopeKey]);

  const topologyDraft = useMemo(() => {
    return (
      readTopologyGraphDraft(draftGraph) ??
      readTopologyGraphDraft((detail?.runtimeTopologyGraph as Record<string, unknown> | null) ?? null)
    );
  }, [detail, draftGraph]);

  const directoryNodes = useMemo(() => readWorkbenchNodesFromGraph(detail?.runtimeTopologyGraph ?? null, detail), [detail]);
  const displayedDirectoryNodes = useMemo(
    () =>
      directoryNodes.map((node) => ({
        ...node,
        statusLabel: nodeStatusOverrides[node.id] ?? node.statusLabel,
      })),
    [directoryNodes, nodeStatusOverrides],
  );

  const topologyNodes = topologyDraft?.nodes ?? [];
  const deployedTopology = readTopologyGraphDraft(detail?.runtimeTopologyGraph ?? null);
  const deployedNodes = deployedTopology?.nodes ?? [];
  const deployedNodeIds = deployedNodes.map(node => node.id);
  const pendingAddedHosts = topologyNodes.filter(node => node.kind === 'ecs' && !deployedNodeIds.includes(node.id));
  const pendingDeletedHosts = deployedNodes.filter(node => node.kind === 'ecs' && !topologyNodes.some(draft => draft.id === node.id));
  const topologyEdges = useMemo<TemplateEdge[]>(() => topologyDraft?.edges ?? [], [topologyDraft]);
  const topologyViewport = readTopologyViewport(topologyDraft?.viewport);
  const selectedTopologyNode = useMemo(
    () =>
      selection.nodeIds.length === 1 && selection.edgeIds.length === 0
        ? topologyNodes.find((node) => node.id === selection.nodeIds[0]) ?? null
        : null,
    [selection, topologyNodes],
  );
  const canOperateInstance = !workspace?.isReadOnly && (!workspace || workspace.capabilities.provisioning) && detail?.status === 'running';
  const canApplyInstance = canOperateInstance && workspace?.capabilities.rangeProvisioning !== false;
  const canEditTopology = canOperateInstance && !isSavingDraft && !isCopyingTemplate && !trackedUpdateJobId;
  const recoveryActionsDisabled = Boolean(workspace?.isReadOnly) || isRecoverySubmitting || Boolean(pendingRecoveryLookup)
    || Boolean(trackedUpdateJobId && recoveryTriggeredJobsRef.current.has(trackedUpdateJobId));
  const canRetryRecovery = detail?.recoverySummary?.canRetry !== false;
  useEffect(() => { if (!canApplyInstance) setChangePreview(null); }, [canApplyInstance]);
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
  useEffect(() => {
    if (
      selection.nodeIds.length === 0 &&
      selection.edgeIds.length === 0 &&
      topologyNodes.length > 0
    ) {
      setSelection({ nodeIds: [topologyNodes[0]!.id], edgeIds: [] });
    }
  }, [selection, topologyNodes]);

  useEffect(() => {
    if (!session.isReady || !session.token || !canOperateInstance) {
      return;
    }

    let isActive = true;

    Promise.all([
      fetchPlatformImages(apiBaseUrl, session.token, 'platform'),
      fetchPlatformImages(apiBaseUrl, session.token, 'mine'),
    ])
      .then(([platformPayload, minePayload]) => {
        if (!isActive) {
          return;
        }

        setPlatformImageAssets(
          [...platformPayload.items, ...minePayload.items]
            .filter((item) => item.enabled)
            .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index),
        );
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

        setErrorMessage(error instanceof Error ? error.message : '平台镜像加载失败，请稍后重试。');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, canOperateInstance, router, session.isReady, session.token]);

  useEffect(() => {
    if (!selectedTopologyNode || selectedTopologyNode.kind !== 'ecs') {
      setInstanceTypeAvailability(null);
      return;
    }

    if (!session.isReady || !session.token) {
      return;
    }

    const cpu = Number(selectedTopologyNode.cpu ?? 0);
    const memory = Number(selectedTopologyNode.memory ?? 0);

    if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) {
      setInstanceTypeAvailability(null);
      return;
    }

    let isActive = true;
    const requestId = instanceTypeAvailabilityRequestRef.current + 1;
    instanceTypeAvailabilityRequestRef.current = requestId;

    fetchInstanceTypeAvailability(apiBaseUrl, session.token, cpu, memory)
      .then((payload) => {
        if (isActive && requestId === instanceTypeAvailabilityRequestRef.current) {
          setInstanceTypeAvailability(payload);
        }
      })
      .catch((error: unknown) => {
        if (!isActive || requestId !== instanceTypeAvailabilityRequestRef.current) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
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
          warning: error instanceof Error ? `规格校验失败：${error.message}` : '规格校验失败，请稍后重试。',
        });
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, router, selectedTopologyNode, session.isReady, session.token]);

  async function persistDraftChanges() {
    if (!session.token || !detail || !topologyDraft) {
      return null;
    }

    setErrorMessage(null);

    const duplicateDnatPorts = findDuplicateDnatExternalPorts(topologyDraft.nodes);

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
      const metadata =
        currentSpec && typeof currentSpec.metadata === 'object'
          ? (currentSpec.metadata as {
              name?: string;
              slug?: string;
              version?: string;
              cloudProvider?: 'alibaba_cloud' | 'tencent_cloud';
              iacType?: 'opentofu' | 'terraform';
              description?: string;
            })
          : {};
      const currentTopology = currentSpec?.topology && typeof currentSpec.topology === 'object'
        ? currentSpec.topology as Record<string, unknown> : {};
      const savedTopology = (detail.draftTopologySpec ?? detail.runtimeTopologySpec) as Record<string, unknown> | null;
      const publicEntry = savedTopology?.publicEntry as { protocols?: Array<{ protocol: string; port: number }> } | undefined;
      const primaryVpcCidr =
        currentSpec &&
        currentSpec.topology &&
        typeof currentSpec.topology === 'object' &&
        typeof (currentSpec.topology as Record<string, unknown>).vpcCidr === 'string'
          ? ((currentSpec.topology as Record<string, unknown>).vpcCidr as string)
          : detail.resourceSummary?.topologySpec?.vpcCidr ?? '10.0.0.0/16';
      let verifiedNodes = restoreDeployedHostDefinitions(topologyDraft.nodes, detail.runtimeTopologyGraph);
      if ((metadata.cloudProvider ?? detail.cloudProvider ?? workspace?.provider) === 'tencent_cloud') {
        verifiedNodes = await Promise.all(verifiedNodes.map(async node => {
          if (node.kind !== 'ecs' || deployedNodeIds.includes(node.id)) return node;
          const image = platformImageAssets.find(asset => asset.id === node.platformImageAssetId && asset.imageId === node.imageId);
          if (!image) throw new Error(`${node.label} 请选择当前工作空间的可用镜像。`);
          const imageError = tencentImageError(image);
          if (imageError) throw new Error(`${node.label} ${imageError}`);
          const cpu = Number(node.cpu); const memory = Number(node.memory);
          if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) throw new Error(`${node.label} 请填写有效的 CPU 和内存规格。`);
          const snapshot = await fetchInstanceTypeAvailability(apiBaseUrl, session.token!, cpu, memory);
          const instanceTypes = verifiedTencentInstanceTypes(snapshot, cpu, memory);
          return { ...node, instanceType: instanceTypes[0], instanceTypeStrategy: { mode: 'prefer-list' as const, preferredInstanceTypes: instanceTypes } };
        }));
        if (scopeRef.current !== scopeKey || workspace?.id && readCloudWorkspaceSelection() !== workspace.id) throw new Error('云账号工作空间已切换，请在当前空间重新保存。');
      }
      const payload = buildTopologyDraftPayload({
        graph: {
          schemaVersion: topologyDraft.schemaVersion,
          nodes: verifiedNodes,
          edges: topologyDraft.edges,
        },
        metadata: {
          name: metadata.name ?? detail.name ?? 'instance-draft',
          slug: metadata.slug ?? detail.id,
          version: metadata.version ?? 'v1',
          cloudProvider: metadata.cloudProvider ?? detail.cloudProvider ?? workspace?.provider ?? 'alibaba_cloud',
          iacType: metadata.iacType ?? 'opentofu',
          ...(metadata.description ? { description: metadata.description } : {}),
          ...(typeof currentTopology.defaultRegion === 'string' ? { defaultRegion: currentTopology.defaultRegion } : {}),
          ...(typeof currentTopology.defaultZoneId === 'string' ? { defaultZoneId: currentTopology.defaultZoneId } : {}),
          modulePathOrRef: detail.templateModulePathSnapshot ?? 'runtime/range-instance',
          primaryVpcCidr,
          ...(publicEntry?.protocols ? { publicEntryProtocols: publicEntry.protocols } : {}),
        },
        viewport: topologyViewport,
        imageOsHints: buildTemplateImageOsHints(platformImageAssets),
      });

      const updated = await saveRangeInstanceDraft(apiBaseUrl, session.token, detail.id, {
        draftTopologyGraph: payload.topologyGraph,
        draftTopologySpec: payload.topologySpec,
        draftScenarioTemplateSpec: payload.scenarioTemplateSpec,
        draftCompiledProvisionSpec: payload.compiledProvisionSpec,
        expectedDraftRevision: detail.draftRevision ?? 0,
      });
      if (scopeRef.current !== scopeKey) return null;

      const nextDetail = {
        ...detail,
        ...updated,
        draftTopologyGraph: updated.draftTopologyGraph ?? payload.topologyGraph,
        sourceTemplateRevision: updated.sourceTemplateRevision ?? detail.sourceTemplateRevision ?? null,
      };
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);

      setDetail(nextDetail);
      replaceTopologyDraft(
        (nextDetail.draftTopologyGraph as Record<string, unknown> | null) ??
          payload.topologyGraph,
      );
      return nextDetail;
    } catch (error: unknown) {
      if (scopeRef.current !== scopeKey) return null;
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return null;
      }

      setErrorMessage(error instanceof Error ? error.message : '保存变更草稿失败，请稍后重试。');
      return null;
    }
  }

  async function handleApplyDraft() {
    if (!session.token || !detail || isSavingDraft || isCopyingTemplate || trackedUpdateJobId || !canApplyInstance) return;
    setIsSavingDraft(true); setErrorMessage(null); setSuccessMessage(null);
    try {
      const saved = await persistDraftChanges();
      if (!saved || !saved.draftRevision) return;
      const preview = await previewRangeInstanceDraft(apiBaseUrl, session.token, detail.id, saved.draftRevision);
      if (scopeRef.current !== scopeKey) return;
      if (preview.rangeInstanceId !== detail.id || preview.expectedDraftRevision !== saved.draftRevision || !preview.previewToken || preview.kind !== 'expected-topology-diff') throw new Error('变更预览返回不一致，请重新预览。');
      setChangePreview(preview);
    } catch (error) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); }
      else setErrorMessage(error instanceof Error ? error.message : '变更预览失败，请重试。');
    } finally { if (scopeRef.current === scopeKey) setIsSavingDraft(false); }
  }

  async function handleConfirmApply() {
    const preview = changePreview;
    if (!session.token || !detail || !preview || !canApplyInstance || isSavingDraft || isCopyingTemplate || trackedUpdateJobId) return;
    if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) { setChangePreview(null); setErrorMessage('变更预览已过期，请重新预览。'); return; }
    setIsSavingDraft(true); setErrorMessage(null);
    try {
      const job = await applyRangeInstanceDraft(apiBaseUrl, session.token, detail.id, preview.expectedDraftRevision, preview.previewToken);
      if (scopeRef.current !== scopeKey) return;
      if (!job.id) throw new Error('应用结果不完整，请刷新查看任务状态。');
      setTrackedUpdateJobId(job.id); setChangePreview(null);
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
      setSuccessMessage('实例配置变更已提交，任务完成后更新运行拓扑。');
    } catch (error) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); }
      else { setChangePreview(null); setErrorMessage(error instanceof Error ? error.message : '提交结果未确认，请刷新查看任务状态后再操作。'); void reloadDetailSnapshot().then(payload => {
        if (scopeRef.current === scopeKey && payload?.lastJobId && payload.lastJobId !== detail.lastJobId) setTrackedUpdateJobId(payload.lastJobId);
      }).catch(() => undefined); }
    } finally { if (scopeRef.current === scopeKey) setIsSavingDraft(false); }
  }

  async function performRecoveryAction(trigger: 'retry' | 'destroy') {
    if (!session.token || !detail || recoveryActionsDisabled) {
      return;
    }

    setIsRecoverySubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    let recoveryJobId: string | null = null;
    try {
      const job = (await triggerRangeAction(apiBaseUrl, session.token, detail.id, trigger)) as { id?: string } | null;
      if (scopeRef.current !== scopeKey) return;
      recoveryJobId = job?.id ?? null;
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
      if (!recoveryJobId) {
        setPendingRecoveryLookup({ previousJobId: detail.lastJobId ?? null });
        setErrorMessage('恢复操作结果未确认，正在查询任务状态。');
        return;
      }
      recoveryTriggeredJobsRef.current.add(recoveryJobId);
      setTrackedUpdateJobId(recoveryJobId);
      setSuccessMessage(trigger === 'destroy' ? '回收任务已提交，正在回收剩余云资源。' : detail.status === 'destroy_failed' ? '重试回收任务已提交。' : '重试创建任务已提交，实例将重新开通。');
      await reloadDetailSnapshot();
    } catch (error) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }
      if (!recoveryJobId) {
        screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
        setPendingRecoveryLookup({ previousJobId: detail.lastJobId ?? null });
        setErrorMessage('恢复操作结果未确认，正在查询任务状态。');
      } else if (recoveryTriggeredJobsRef.current.has(recoveryJobId)) {
        setErrorMessage('任务状态刷新失败，正在重试。');
      }
    } finally {
      if (scopeRef.current === scopeKey) {
        setIsRecoverySubmitting(false);
        setPendingRecoveryTrigger(null);
      }
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
      if (scopeRef.current === scopeKey) setIsSavingDraft(false);
    }
  }

  async function handleConfirmCopyTemplate() {
    if (!session.token || !detail || isCopyingTemplate || !templateCopyName.trim()) return;
    setIsCopyingTemplate(true); setErrorMessage(null); setSuccessMessage(null);
    const name = templateCopyName.trim(), description = templateCopyDescription.trim();
    try {
      const graph = JSON.stringify(topologyDraft);
      let request = copyRequestRef.current;
      if (!request || request.scope !== identityKey || request.graph !== graph || request.name !== name || request.description !== description) {
        const saved = await persistDraftChanges();
        if (!saved?.draftRevision) return;
        request = { scope: identityKey, graph: JSON.stringify(readTopologyGraphDraft(saved.draftTopologyGraph ?? saved.runtimeTopologyGraph)), name, description, revision: saved.draftRevision, key: crypto.randomUUID() };
        copyRequestRef.current = request;
      }
      const result = await saveRangeInstanceAsTemplate(apiBaseUrl, session.token, detail.id, { name, description, expectedDraftRevision: request.revision }, request.key);
      if (scopeRef.current !== scopeKey) return;
      if (!result.templateId || result.rangeInstanceId !== detail.id || result.sourceDraftRevision !== request.revision || result.visibility !== 'private') throw new Error('另存返回不一致，请使用原请求重试。');
      screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
      setSuccessMessage(`已另存为私有拓扑“${result.name}”，原拓扑保持不变。`);
      copyRequestRef.current = null; setIsTemplateCopyDialogOpen(false);
    } catch (error) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); }
      else setErrorMessage(error instanceof Error ? error.message : '另存结果未确认，请保持名称和配置不变后重试。');
    } finally { if (scopeRef.current === scopeKey) setIsCopyingTemplate(false); }
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
      if (scopeRef.current !== scopeKey) return;

      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
      screenCache?.invalidate(apiBaseUrl, session.token, 'image-center:');
      screenCache?.invalidate(apiBaseUrl, session.token, 'platform-images:');
      setPackImageDialog(null);
      setSuccessMessage(
        result.imageReady
          ? `镜像打包完成，已保存到我的镜像：${result.platformImageAsset?.displayName ?? packImageDialog.displayName}`
          : `镜像打包任务已提交，镜像可用后会出现在我的镜像：${packImageDialog.displayName}`,
      );
    } catch (error: unknown) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '二次打包镜像失败，请稍后重试。');
    } finally {
      if (scopeRef.current === scopeKey) setPendingNodeAction(null);
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
      if (scopeRef.current !== scopeKey) { vncWindow?.close(); return; }
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);

      if (action === 'verify-dns') {
        if (result.dnsVerification) {
          setDetail((current) => current ? { ...current, dnsVerification: { ...current.dnsVerification, [nodeId]: result.dnsVerification! } } : current);
        }
        if (result.dnsVerification?.status === 'verified') {
          setSuccessMessage('DNS 核验通过，主机内的 DNS 配置已生效。');
        } else if (result.dnsVerification?.status === 'pending' || result.dnsVerification?.status === 'checking') {
          setSuccessMessage('DNS 核验已提交，请查看节点的独立验证状态。');
        } else {
          setErrorMessage('DNS 核验未通过，请检查网卡、DNS 服务与初始化状态。实例不会自动重建。');
        }
        await reloadDetailSnapshot();
      }

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
      if (scopeRef.current !== scopeKey) { vncWindow?.close(); return; }
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      vncWindow?.close();
      const message = error instanceof Error ? error.message : '节点操作失败，请稍后重试。';
      setErrorMessage(action === 'verify-dns' ? `${message} 实例不会自动重建。` : message);
    } finally {
      if (scopeRef.current === scopeKey) setPendingNodeAction(null);
    }
  }

  function commitTopologySnapshot(snapshot: TopologySnapshot, message: string) {
    if (!canEditTopology) {
      return;
    }

    const baseHistory = historyRef.current ?? createTopologyHistory({
      nodes: topologyNodes,
      edges: topologyEdges,
      viewport: topologyViewport,
    });
    const nextHistory = pushTopologySnapshot(baseHistory, snapshot);
    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setChangePreview(null);
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: nextHistory.present.nodes,
      edges: nextHistory.present.edges,
    }, nextHistory.present.viewport));
    setSuccessMessage(null);
    setErrorMessage(null);
  }

  function restoreTopologyHistory(nextHistory: TopologyHistory, message: string) {
    if (!canEditTopology || nextHistory === historyRef.current) {
      return;
    }

    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setChangePreview(null);
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: nextHistory.present.nodes,
      edges: nextHistory.present.edges,
    }, nextHistory.present.viewport));
    setSelection({ nodeIds: [], edgeIds: [] });
    setChangePreview(null);
    setSuccessMessage(message);
    setErrorMessage(null);
  }

  function handleSelectionChange(nextSelection: TopologySelection) {
    const validSelection: TopologySelection = {
      nodeIds: [...new Set(nextSelection.nodeIds.filter((nodeId) => topologyNodes.some((node) => node.id === nodeId)))],
      edgeIds: [...new Set(nextSelection.edgeIds.filter((edgeId) => topologyEdges.some((edge) => edge.id === edgeId)))],
    };

    setSelection((current) => hasSameTopologySelection(current, validSelection) ? current : validSelection);
  }

  function handleFlowNodeActivate(nodeId: string) {
    if (!topologyNodes.some((node) => node.id === nodeId)) {
      return;
    }

    setSelection({ nodeIds: [nodeId], edgeIds: [] });
  }

  function handleAddTopologyNode(kind: 'router' | 'switch' | 'ecs', position?: { x: number; y: number }) {
    if (!canEditTopology) {
      return;
    }

    if (kind === 'router' && topologyNodes.some((node) => node.kind === 'router')) {
      setErrorMessage('当前拓扑只允许一个 Router。');
      return;
    }

    let kindOrdinal = topologyNodes.filter((node) => node.kind === kind).length + 1;
    while (topologyNodes.some((node) => node.kind === kind && node.label === readDefaultNodeLabel(kind, kindOrdinal))) kindOrdinal += 1;
    const nextNodeId = nextAvailableGraphId(kind, [...new Set([
      ...[...topologyNodes, ...deployedNodes].map(node => node.id),
      ...Object.keys(detail?.resourceSummary?.cloudReleaseDeadlines ?? {}),
    ])]);
    let switchCidr = '';
    if (kind === 'switch') {
      try {
        switchCidr = nextAvailableSwitchCidr(topologyNodes);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '没有可用的交换机网段');
        return;
      }
    }
    const nextNode: TemplateNode =
      kind === 'router'
        ? {
            id: nextNodeId,
            kind: 'router',
            label: readDefaultNodeLabel('router', kindOrdinal),
            position: createNodePosition('router', kindOrdinal),
            description: '',
            routeRole: 'egress',
            egressType: 'internet',
            bindEip: false,
          }
        : kind === 'switch'
          ? { ...createDefaultSwitchNode(
              nextNodeId,
              readDefaultNodeLabel('switch', kindOrdinal),
              kindOrdinal,
            ), cidr: switchCidr, zoneKey: nextAvailableGraphId('zone', topologyNodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch').map((node) => node.zoneKey)) }
          : createDefaultEcsNode(nextNodeId, readDefaultNodeLabel('ecs', kindOrdinal), kindOrdinal, detail?.cloudProvider ?? workspace?.provider);
    const positionedNode =
      position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { ...nextNode, position }
        : nextNode;

    commitTopologySnapshot(
      { nodes: [...topologyNodes, positionedNode], edges: topologyEdges, viewport: topologyViewport },
      `已添加 ${positionedNode.label}，请补充属性和连接关系。`,
    );
    setSelection({ nodeIds: [positionedNode.id], edgeIds: [] });
  }

  function handleConnectTopologyNodes(connection: { source: string; target: string }) {
    if (!canEditTopology) {
      return;
    }

    const sourceNode = topologyNodes.find((node) => node.id === connection.source) ?? null;
    const targetNode = topologyNodes.find((node) => node.id === connection.target) ?? null;

    if (!sourceNode || !targetNode) {
      setErrorMessage('连线节点不存在，请重新选择。');
      return;
    }

    const isRouterSwitchPair =
      (sourceNode.kind === 'router' && targetNode.kind === 'switch')
      || (sourceNode.kind === 'switch' && targetNode.kind === 'router');
    const isSwitchEcsPair =
      (sourceNode.kind === 'switch' && targetNode.kind === 'ecs')
      || (sourceNode.kind === 'ecs' && targetNode.kind === 'switch');

    if (!isRouterSwitchPair && !isSwitchEcsPair) {
      setErrorMessage('第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线。');
      return;
    }

    const canonicalSource = sourceNode.kind === 'router' || sourceNode.kind === 'switch' && targetNode.kind === 'ecs'
      ? sourceNode
      : targetNode;
    const canonicalTarget = canonicalSource === sourceNode ? targetNode : sourceNode;
    const alreadyLinked = topologyEdges.some(
      (edge) => edge.fromNodeId === canonicalSource.id && edge.toNodeId === canonicalTarget.id,
    );

    if (alreadyLinked) {
      setErrorMessage('已存在相同连线。');
      return;
    }

    if (canonicalTarget.kind === 'ecs' && deployedNodeIds.includes(canonicalTarget.id)) { setErrorMessage('已有主机的网卡与交换机关联不可迁移，请只为新主机建立连接。'); return; }
    const nextNodes =
      canonicalSource.kind === 'switch' && canonicalTarget.kind === 'ecs'
        ? topologyNodes.map((node) =>
            node.id === canonicalTarget.id && node.kind === 'ecs'
              ? syncHostNicsWithLinkedSwitch(node, canonicalSource)
              : node,
          )
        : topologyNodes;
    const nextEdge: TemplateEdge = {
      id: `edge-${canonicalSource.id}-${canonicalTarget.id}`,
      fromNodeId: canonicalSource.id,
      toNodeId: canonicalTarget.id,
      relationType: 'manual',
      label: `${canonicalSource.label} -> ${canonicalTarget.label}`,
    };

    commitTopologySnapshot(
      { nodes: nextNodes, edges: [...topologyEdges, nextEdge], viewport: topologyViewport },
      `已创建连线：${canonicalSource.label} -> ${canonicalTarget.label}`,
    );
    setSelection({ nodeIds: [canonicalTarget.id], edgeIds: [] });
  }

  function handleDeleteTopologySelection() {
    if (!canEditTopology) {
      return;
    }

    const nodeIds = new Set(selection.nodeIds);
    const edgeIds = new Set(selection.edgeIds);
    const deletedNodes = topologyNodes.filter((node) => nodeIds.has(node.id));
    const deletedEdges = topologyEdges.filter(
      (edge) => edgeIds.has(edge.id) || nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId),
    );

    if (deletedNodes.some(node => node.kind === 'ecs') && !topologyNodes.some(node => node.kind === 'ecs' && !nodeIds.has(node.id))) {
      setErrorMessage('编排至少需要保留一台主机；回收全部资源请使用编排实例列表的销毁操作。');
      return;
    }

    if (deletedNodes.length === 0 && deletedEdges.length === 0) {
      setErrorMessage('请先选择节点或连线，再执行删除。');
      return;
    }

    if (deletedNodes.some(node => node.kind !== 'ecs' && deployedNodeIds.includes(node.id)) || deletedEdges.some(edge => deployedNodeIds.includes(edge.toNodeId) && !nodeIds.has(edge.toNodeId))) { setErrorMessage('已部署网络及已有主机的网卡连接不可删除；可删除主机或尚未部署的节点。'); return; }
    let nextNodes = topologyNodes.filter((node) => !nodeIds.has(node.id));
    deletedNodes.forEach((node) => {
      nextNodes = cleanupNodeReferencesAfterDeletion(nextNodes, node);
    });
    deletedEdges.forEach((edge) => {
      nextNodes = cleanupEdgeReferencesAfterDeletion(nextNodes, edge);
    });
    const nextEdges = topologyEdges.filter((edge) => !deletedEdges.includes(edge));

    commitTopologySnapshot(
      { nodes: nextNodes, edges: nextEdges, viewport: topologyViewport },
      deletedNodes.length > 0 ? `已删除 ${deletedNodes.length} 个节点。` : '已删除连线。',
    );
    setSelection({ nodeIds: [], edgeIds: [] });
  }

  function handleUpdateTopologyNode(nodeId: string, nextNode: TemplateNode) {
    if (!canEditTopology) {
      return;
    }

    const nextNodes = topologyNodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }

      if (node.kind !== 'ecs' || nextNode.kind !== 'ecs' || deployedNodeIds.includes(node.id)) {
        return nextNode;
      }

      const privateIp = nextNode.nics?.[0]?.privateIp.trim() || nextNode.privateIp.trim();
      const preferredInstanceTypes = (detail?.cloudProvider ?? workspace?.provider) === 'tencent_cloud' ? [] : resolvePreferredInstanceTypes(nextNode.cpu, nextNode.memory);
      return {
        ...nextNode,
        privateIp,
        instanceType: preferredInstanceTypes[0],
        instanceTypeStrategy: preferredInstanceTypes.length > 0
          ? { mode: 'prefer-list' as const, preferredInstanceTypes: [...preferredInstanceTypes] }
          : { mode: 'auto' as const, preferredInstanceTypes: [] },
      };
    });

    const next = reconcileHostNicConnections(topologyNodes, nextNodes, topologyEdges, nodeId);
    commitTopologySnapshot({ ...next, viewport: topologyViewport }, '已更新节点属性。');
  }

  function handlePositionsCommit(positions: Array<{ id: string; position: { x: number; y: number } }>) {
    if (!canEditTopology) {
      return;
    }

    const positionsById = new Map(
      positions
        .filter(({ position }) => Number.isFinite(position.x) && Number.isFinite(position.y))
        .map(({ id, position }) => [id, position]),
    );
    const nextNodes = topologyNodes.map((node) =>
      positionsById.has(node.id) ? { ...node, position: positionsById.get(node.id)! } : node,
    );

    commitTopologySnapshot({ nodes: nextNodes, edges: topologyEdges, viewport: topologyViewport }, '已更新节点位置。');
  }

  function handleViewportCommit(viewport: TopologyViewport) {
    if (!canEditTopology || !readTopologyViewport(viewport)) {
      return;
    }

    const currentHistory = historyRef.current ?? createTopologyHistory({
      nodes: topologyNodes,
      edges: topologyEdges,
      viewport: topologyViewport,
    });
    historyRef.current = {
      ...currentHistory,
      present: {
        ...currentHistory.present,
        viewport,
      },
    };
    setHistoryState(historyRef.current);
    setChangePreview(null);
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: topologyNodes,
      edges: topologyEdges,
    }, viewport));
  }

  function handleLayoutAll() {
    if (!canEditTopology || topologyNodes.length === 0) {
      return;
    }

    try {
      commitTopologySnapshot(
        { nodes: layoutTopology(topologyNodes, topologyEdges), edges: topologyEdges, viewport: topologyViewport },
        '',
      );
    } catch {
      setErrorMessage('自动布局失败，请保留当前节点位置。');
    }
  }

  function handleUndo() {
    if (canEditTopology && historyRef.current) {
      restoreTopologyHistory(undoTopology(historyRef.current), '已撤销上一步拓扑操作。');
    }
  }

  function handleRedo() {
    if (canEditTopology && historyRef.current) {
      restoreTopologyHistory(redoTopology(historyRef.current), '已重做上一步拓扑操作。');
    }
  }

  return (
    <main className="admin-screen range-instance-detail-screen min-w-0">
      <section className="admin-workbench-surface range-instance-detail-workbench">
        <AdminPageHeader
          description="查看实例运行状态、节点目录与拓扑编排。"
          title="实例详情"
          action={session.profile?.isPlatformManager ? <Button asChild variant="outline"><Link href="/admin/resource-alerts">资源告警</Link></Button> : undefined}
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
                  <span>平台到期</span>
                  <strong>{formatAdminDateTime(detail.expiresAt)}</strong>
                </div>
                <div className="range-instance-overview-item">
                  <span>云端兜底</span>
                  <strong><CloudReleaseSummary deadlines={detail.resourceSummary?.cloudReleaseDeadlines} hostIds={detail.resourceSummary?.hostIds} /></strong>
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

            {detail.status === 'create_failed' || detail.status === 'destroy_failed' ? (
              <section aria-label="失败恢复" className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      实例恢复{detail.recoverySummary ? ` · ${readRecoveryCategoryLabel(detail.recoverySummary.category)}` : ''}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {detail.recoverySummary?.summary ?? detail.errorSummary?.trim() ?? '实例当前处于失败状态，请查看任务详情确认原因。'}
                    </p>
                    {detail.recoverySummary?.suggestions.length ? (
                      <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                        {detail.recoverySummary.suggestions.map((suggestion) => (
                          <li key={suggestion}>{suggestion}</li>
                        ))}
                      </ul>
                    ) : null}
                    {detail.status === 'create_failed' && !canRetryRecovery ? (
                      <p className="mt-1 text-xs text-destructive">该失败通常需要先按上述建议处理根因；确认已处理后可直接重试创建。</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {pendingRecoveryLookup ? (
                      <Button onClick={() => setPendingRecoveryLookup({ ...pendingRecoveryLookup })} size="sm" type="button" variant="outline">
                        查询恢复状态
                      </Button>
                    ) : null}
                    {detail.status === 'create_failed' ? (
                      <Button
                        disabled={recoveryActionsDisabled}
                        onClick={() => void performRecoveryAction('retry')}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {isRecoverySubmitting && pendingRecoveryTrigger === null ? '处理中...' : '重试创建'}
                      </Button>
                    ) : null}
                    {detail.status === 'destroy_failed' ? (
                      <Button disabled={recoveryActionsDisabled} onClick={() => setPendingRecoveryTrigger('retry')} size="sm" type="button" variant="outline">
                        重试回收
                      </Button>
                    ) : null}
                    {detail.status === 'create_failed' ? (
                      <Button disabled={recoveryActionsDisabled} onClick={() => setPendingRecoveryTrigger('destroy')} size="sm" type="button" variant="destructive">
                        回收资源
                      </Button>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            <div className="range-instance-detail-toolbar">
              <Tabs onValueChange={(value) => setActiveTab(value as WorkbenchTab)} value={activeTab}>
                <TabsList aria-label="实例详情视图切换" variant="line">
                  <TabsTrigger value="directory">
                    节点目录
                  </TabsTrigger>
                  <TabsTrigger value="topology"
                    onMouseEnter={() => void preloadRangeInstanceTopologyWorkspace().catch(() => undefined)}
                    onFocus={() => void preloadRangeInstanceTopologyWorkspace().catch(() => undefined)}>
                    拓扑结构
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {activeTab === 'topology' && canOperateInstance ? (
                <div className="range-instance-workbench-actions">
                  <Button disabled={!canEditTopology} onClick={() => handleAddTopologyNode('ecs')} size="sm" type="button" variant="outline">添加主机</Button>
                  <Button
                    disabled={isSavingDraft || isCopyingTemplate}
                    onClick={() => void handleSaveDraft()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                      {isSavingDraft ? '处理中...' : '保存草稿'}
                  </Button>
                  <Button
                    disabled={!canApplyInstance || isSavingDraft || isCopyingTemplate || Boolean(trackedUpdateJobId)}
                    title={!canApplyInstance ? '当前云账号尚未开放编排资源变更。' : undefined}
                    onClick={() => void handleApplyDraft()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                      {isSavingDraft ? '处理中...' : '预览变更'}
                  </Button>
                  <Button
                    disabled={isSavingDraft || isCopyingTemplate}
                    onClick={() => { setTemplateCopyName(templateCopyName || `${detail.name ?? '编排'}-副本`); setIsTemplateCopyDialogOpen(true); }}
                    size="sm"
                    type="button"
                  >
                      {isCopyingTemplate ? '处理中...' : '另存为新拓扑'}
                  </Button>
                </div>
              ) : null}
            </div>

            {activeTab === 'topology' && (pendingAddedHosts.length > 0 || pendingDeletedHosts.length > 0) ? <div className="mb-3 flex flex-wrap gap-3 text-sm" role="status"><span>待创建主机 {pendingAddedHosts.length}</span><span className={pendingDeletedHosts.length ? 'text-destructive' : ''}>待回收主机 {pendingDeletedHosts.length}</span><span className="text-muted-foreground">草稿尚未应用</span></div> : null}
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
                      cloudReleaseDeadline: detail.resourceSummary?.cloudReleaseDeadlines?.[node.id],
                      createdAt: formatAdminDateTime(detail.createdAt),
                    }))}
                    onNodeAction={handleNodeAction}
                    allowActions={canOperateInstance}
                    pendingAction={pendingNodeAction}
                    isRefreshing={isRefreshingDetail}
                  />
                </div>
              ) : (
                <RangeInstanceTopologyWorkspace
                  editable={canEditTopology}
                  deployedNodeIds={deployedNodeIds}
                  nodes={topologyNodes}
                  edges={topologyEdges}
                  linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
                  instanceTypeAvailability={instanceTypeAvailability}
                  platformImageAssets={platformImageAssets}
                  runtimeNodeStatus={selectedTopologyNode ? detail?.nodeStatuses?.[selectedTopologyNode.id] ?? null : null}
                  selection={selection}
                  viewport={topologyViewport}
                  onAddNode={handleAddTopologyNode}
                  onConnect={handleConnectTopologyNodes}
                  onDeleteSelection={handleDeleteTopologySelection}
                  onLayoutAll={handleLayoutAll}
                  onNodeActivate={handleFlowNodeActivate}
                  onPositionsCommit={handlePositionsCommit}
                  onRedo={handleRedo}
                  onSelectionChange={handleSelectionChange}
                  onUndo={handleUndo}
                  onUpdateNode={handleUpdateTopologyNode}
                  onViewportCommit={handleViewportCommit}
                />
              )}
            </div>
          </>
        ) : errorMessage ? <AsyncContentState title="实例详情加载失败" description="请重试加载或返回编排实例列表。" variant="error" onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />
          : <RangeInstanceDetailBodySkeleton />}
      </section>

      <RangeChangePreviewDialog preview={changePreview} pending={isSavingDraft} onClose={() => setChangePreview(null)} onConfirm={() => void handleConfirmApply()} />
      <ConfirmActionDialog
        confirmLabel={pendingRecoveryTrigger === 'retry' ? '确认重试' : '确认回收'}
        description={pendingRecoveryTrigger === 'retry'
          ? `将重新执行回收任务，继续删除“${detail?.name?.trim() || rangeId}”的剩余云资源；回收完成后无法恢复。`
          : `将回收“${detail?.name?.trim() || rangeId}”已创建的云主机与随实例磁盘；回收完成后无法恢复。`}
        open={pendingRecoveryTrigger !== null}
        pending={isRecoverySubmitting}
        title={pendingRecoveryTrigger === 'retry' ? '重试回收实例资源' : '回收失败实例资源'}
        onConfirm={() => {
          if (pendingRecoveryTrigger) {
            void performRecoveryAction(pendingRecoveryTrigger);
          }
        }}
        onOpenChange={(open) => {
          if (!open && !isRecoverySubmitting) {
            setPendingRecoveryTrigger(null);
          }
        }}
      />
      <AdminDialog open={isTemplateCopyDialogOpen} title="另存为新拓扑" description="保存当前草稿为新的私有编排拓扑，原拓扑和运行资源保持不变。" pending={isCopyingTemplate}
        onOpenChange={setIsTemplateCopyDialogOpen} footer={<><Button disabled={isCopyingTemplate} variant="outline" onClick={() => setIsTemplateCopyDialogOpen(false)}>取消</Button><Button disabled={isCopyingTemplate || !templateCopyName.trim()} onClick={() => void handleConfirmCopyTemplate()}>{isCopyingTemplate ? '正在保存…' : '保存新拓扑'}</Button></>}>
        <div className="grid gap-3"><label className="grid gap-2 text-sm"><span>新拓扑名称</span><Input autoFocus maxLength={80} aria-label="新拓扑名称" value={templateCopyName} disabled={isCopyingTemplate} onChange={event => setTemplateCopyName(event.target.value)} /></label><label className="grid gap-2 text-sm"><span>描述</span><Input aria-label="新拓扑描述" value={templateCopyDescription} disabled={isCopyingTemplate} onChange={event => setTemplateCopyDescription(event.target.value)} /></label></div>
      </AdminDialog>

      {packImageDialog && detail ? (
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
                <Input
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
                <Input
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
                <Input
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
                <Input
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
