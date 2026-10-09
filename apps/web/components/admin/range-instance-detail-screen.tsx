'use client';

import React from 'react';
import { defaultSwitchCidr as readDefaultSwitchCidr, nextAvailableGraphId } from '@aliyun-cyber-range/scenario-runtime';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  applyRangeInstanceDraft,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  fetchProvisionJobDetail,
  fetchRangeInstanceDetail,
  runRangeInstanceNodeAction,
  saveRangeInstanceDraft,
  syncRangeInstanceTemplate,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  RangeInstanceDetail,
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
import { buildTopologyDraftPayload } from '../../lib/topology-draft-payload';
import { RangeInstanceNodeDirectory } from './range-instance-node-directory';
import { RangeInstanceDetailBodySkeleton, RangeInstanceTopologyLoading } from './range-instance-detail-loading';
import { AsyncContentState } from './shared/async-content-state';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPageHeader } from './shared/admin-page-header';
import { ConfirmActionDialog } from './shared/confirm-action-dialog';
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
type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'reset' | 'pack-image';
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

function createDefaultEcsNode(id: string, label: string, ordinal: number): EcsTemplateNode {
  const preferredInstanceTypes = resolvePreferredInstanceTypes(2, 2);

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
    ...(typeof value.account === 'string' ? { account: value.account } : {}),
    ...(typeof value.password === 'string' ? { password: value.password } : {}),
  } as EcsTemplateNode;
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
  const screenCache = useAdminScreenCache();
  const isPageActive = useAdminRouteIsActive(`/admin/ranges/${rangeId}`);
  const resourceKey = `range-instance-detail:${rangeId}:${session.profile?.id ?? 'current-session'}:${session.profile?.role ?? ''}`;
  const identityKey = `${apiBaseUrl}\u0000${session.profile?.id ?? 'current-session'}\u0000${session.profile?.role ?? ''}\u0000${rangeId}`;
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
  const [isSyncingTemplate, setIsSyncingTemplate] = useState(false);
  const [isTemplateSyncDialogOpen, setIsTemplateSyncDialogOpen] = useState(false);
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
  const [, setHistoryState] = useState<TopologyHistory | null>(null);
  const instanceTypeAvailabilityRequestRef = useRef(0);

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
      setPackImageDialog(null);
      setIsTemplateSyncDialogOpen(false);
      setPendingNodeAction(null);
      setSuccessMessage(null);
      setIsSavingDraft(false);
      setIsSyncingTemplate(false);
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
  }, [apiBaseUrl, isPageActive, loadAttempt, rangeId, router, screenCache, session.isReady, session.token, session.profile?.id, session.profile?.role]);

  useEffect(() => {
    if (!isPageActive || !session.token || !trackedUpdateJobId) {
      return;
    }

    let isActive = true;
    let timer: number | undefined;
    const token = session.token;
    const jobId = trackedUpdateJobId;

    async function refreshUpdateJob() {
      try {
        const { job } = await fetchProvisionJobDetail(apiBaseUrl, token, jobId);
        if (!isActive) return;
        if (job.jobType !== 'update') {
          setTrackedUpdateJobId(null);
          return;
        }

        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          const payload = await fetchRangeInstanceDetail(apiBaseUrl, token, rangeId);
          if (!isActive) return;
          receiveDetailSnapshot(payload);
          setTrackedUpdateJobId(null);
          screenCache?.invalidate(apiBaseUrl, token, 'range-instances:');
          screenCache?.invalidate(apiBaseUrl, token, resourceKey);
          setSuccessMessage(job.status === 'succeeded' ? '实例配置变更已应用。' : null);
          setErrorMessage(job.status === 'succeeded' ? null : job.errorSummary || '实例配置变更未完成，请检查任务后重试。');
          return;
        }
        setSuccessMessage('实例配置变更正在应用。');
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
  }, [apiBaseUrl, isPageActive, rangeId, router, screenCache, session.token, trackedUpdateJobId, scopeKey]);

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
  const topologyViewport = readTopologyViewport(topologyDraft?.viewport);
  const selectedTopologyNode = useMemo(
    () =>
      selection.nodeIds.length === 1 && selection.edgeIds.length === 0
        ? topologyNodes.find((node) => node.id === selection.nodeIds[0]) ?? null
        : null,
    [selection, topologyNodes],
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
              cloudProvider?: 'alibaba_cloud';
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
      const payload = buildTopologyDraftPayload({
        graph: {
          schemaVersion: topologyDraft.schemaVersion,
          nodes: topologyDraft.nodes,
          edges: topologyDraft.edges,
        },
        metadata: {
          name: metadata.name ?? detail.name ?? 'instance-draft',
          slug: metadata.slug ?? detail.id,
          version: metadata.version ?? 'v1',
          cloudProvider: metadata.cloudProvider ?? 'alibaba_cloud',
          iacType: metadata.iacType ?? 'opentofu',
          ...(metadata.description ? { description: metadata.description } : {}),
          ...(typeof currentTopology.defaultRegion === 'string' ? { defaultRegion: currentTopology.defaultRegion } : {}),
          ...(typeof currentTopology.defaultZoneId === 'string' ? { defaultZoneId: currentTopology.defaultZoneId } : {}),
          modulePathOrRef: detail.templateModulePathSnapshot ?? 'runtime/range-instance',
          primaryVpcCidr,
          ...(publicEntry?.protocols ? { publicEntryProtocols: publicEntry.protocols } : {}),
        },
        viewport: topologyViewport,
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
        ...updated,
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
    if (!session.token || !detail || trackedUpdateJobId) {
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

      const job = await applyRangeInstanceDraft(apiBaseUrl, session.token, detail.id, expectedDraftRevision);
      if (scopeRef.current !== scopeKey) return;
      setTrackedUpdateJobId(job.id);
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
      setSuccessMessage('实例配置变更已提交应用。');
    } catch (error: unknown) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('应用变更失败，请稍后重试。');
    } finally {
      if (scopeRef.current === scopeKey) setIsSavingDraft(false);
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

  async function handleConfirmSyncTemplate() {
    if (!session.token || !detail) {
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

      if (
        typeof saved.draftRevision !== 'number' ||
        !Number.isInteger(saved.draftRevision) ||
        saved.draftRevision < 1 ||
        typeof saved.sourceTemplateRevision !== 'number' ||
        !Number.isInteger(saved.sourceTemplateRevision) ||
        saved.sourceTemplateRevision < 1
      ) {
        throw new Error('实例或模板版本已变化，请刷新后重新保存草稿。');
      }

      await syncRangeInstanceTemplate(
        apiBaseUrl,
        session.token,
        detail.id,
        saved.draftRevision,
        saved.sourceTemplateRevision,
      );
      if (scopeRef.current !== scopeKey) return;
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, resourceKey);
      screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
      setSuccessMessage('当前实例拓扑已更新到模板草稿。');
      setIsTemplateSyncDialogOpen(false);
    } catch (error: unknown) {
      if (scopeRef.current !== scopeKey) return;
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '更新编排拓扑失败，请稍后重试。');
    } finally {
      if (scopeRef.current === scopeKey) setIsSyncingTemplate(false);
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
      setErrorMessage(error instanceof Error ? error.message : '节点操作失败，请稍后重试。');
    } finally {
      if (scopeRef.current === scopeKey) setPendingNodeAction(null);
    }
  }

  function commitTopologySnapshot(snapshot: TopologySnapshot, message: string) {
    if (!canOperateInstance) {
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
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: nextHistory.present.nodes,
      edges: nextHistory.present.edges,
    }, nextHistory.present.viewport));
    setSuccessMessage(null);
    setErrorMessage(null);
  }

  function restoreTopologyHistory(nextHistory: TopologyHistory, message: string) {
    if (!canOperateInstance || nextHistory === historyRef.current) {
      return;
    }

    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: nextHistory.present.nodes,
      edges: nextHistory.present.edges,
    }, nextHistory.present.viewport));
    setSelection({ nodeIds: [], edgeIds: [] });
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
    if (!canOperateInstance) {
      return;
    }

    if (kind === 'router' && topologyNodes.some((node) => node.kind === 'router')) {
      setErrorMessage('当前拓扑只允许一个 Router。');
      return;
    }

    let kindOrdinal = topologyNodes.filter((node) => node.kind === kind).length + 1;
    while (topologyNodes.some((node) => node.kind === kind && node.label === readDefaultNodeLabel(kind, kindOrdinal))) kindOrdinal += 1;
    const nextNodeId = nextAvailableGraphId(kind, topologyNodes.map((node) => node.id));
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
          : createDefaultEcsNode(nextNodeId, readDefaultNodeLabel('ecs', kindOrdinal), kindOrdinal);
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
    if (!canOperateInstance) {
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
    if (!canOperateInstance) {
      return;
    }

    const nodeIds = new Set(selection.nodeIds);
    const edgeIds = new Set(selection.edgeIds);
    const deletedNodes = topologyNodes.filter((node) => nodeIds.has(node.id));
    const deletedEdges = topologyEdges.filter(
      (edge) => edgeIds.has(edge.id) || nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId),
    );

    if (deletedNodes.length === 0 && deletedEdges.length === 0) {
      setErrorMessage('请先选择节点或连线，再执行删除。');
      return;
    }

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
    if (!canOperateInstance) {
      return;
    }

    const nextNodes = topologyNodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }

      if (node.kind !== 'ecs' || nextNode.kind !== 'ecs') {
        return nextNode;
      }

      const privateIp = nextNode.nics?.[0]?.privateIp.trim() || nextNode.privateIp.trim();
      const preferredInstanceTypes = resolvePreferredInstanceTypes(nextNode.cpu, nextNode.memory);
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
    if (!canOperateInstance) {
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
    if (!canOperateInstance || !readTopologyViewport(viewport)) {
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
    setDraftGraph(writeTopologyViewport({
      schemaVersion: INSTANCE_TOPOLOGY_SCHEMA_VERSION,
      nodes: topologyNodes,
      edges: topologyEdges,
    }, viewport));
  }

  function handleLayoutAll() {
    if (!canOperateInstance || topologyNodes.length === 0) {
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
    if (historyRef.current) {
      restoreTopologyHistory(undoTopology(historyRef.current), '已撤销上一步拓扑操作。');
    }
  }

  function handleRedo() {
    if (historyRef.current) {
      restoreTopologyHistory(redoTopology(historyRef.current), '已重做上一步拓扑操作。');
    }
  }

  return (
    <main className="admin-screen range-instance-detail-screen min-w-0">
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
                  <TabsTrigger value="topology"
                    onMouseEnter={() => void preloadRangeInstanceTopologyWorkspace().catch(() => undefined)}
                    onFocus={() => void preloadRangeInstanceTopologyWorkspace().catch(() => undefined)}>
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
                    disabled={isSavingDraft || isSyncingTemplate || Boolean(trackedUpdateJobId)}
                    onClick={() => void handleApplyDraft()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                      {isSavingDraft ? '处理中...' : '应用变更'}
                  </Button>
                  <Button
                    disabled={isSavingDraft || isSyncingTemplate}
                    onClick={() => setIsTemplateSyncDialogOpen(true)}
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
                    isRefreshing={isRefreshingDetail}
                  />
                </div>
              ) : (
                <RangeInstanceTopologyWorkspace
                  editable={canOperateInstance}
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

      <ConfirmActionDialog
        confirmLabel="确认更新模板草稿"
        description="将当前实例已保存的拓扑草稿覆盖到来源模板的当前草稿版本。此操作不会自动发布模板，也不会影响其他已运行实例。"
        onConfirm={() => void handleConfirmSyncTemplate()}
        onOpenChange={setIsTemplateSyncDialogOpen}
        open={isTemplateSyncDialogOpen}
        pending={isSyncingTemplate}
        title="更新编排拓扑"
      />

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
