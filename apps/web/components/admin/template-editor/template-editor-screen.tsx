'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { validateAliyunEcsPassword } from '@aliyun-cyber-range/scenario-runtime';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import {
  AdminApiError,
  createRangeTemplate,
  fetchRangeTemplateById,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  shareRangeTemplate,
  validateAndSaveRangeTemplate,
} from '../../../lib/admin-api';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset, RangeTemplate } from '../../../lib/admin-types';
import type { ScenarioTemplateMetadata } from '../../../lib/scenario-template-spec';
import { resolveFixedInstanceType, resolvePreferredInstanceTypes } from '../../../lib/instance-type-catalog';
import { buildScenarioTemplateSpecFromTopologyGraph } from '../../../lib/topology-graph-to-scenario-template';
import { compileScenarioTemplateSpec } from '../../../lib/scenario-template-compiler';
import {
  findDuplicateDnatExternalPorts,
  isPhaseOneNodeKind as isPhaseOneNodeKindTypeGuard,
} from '../../../lib/scenario-graph';
import { normalizeManualEdgePair, validateManualEdge } from '../../../lib/scenario-graph-linking';
import type {
  EcsTemplateNode,
  ScenarioGraphDraft,
  ScenarioGraphEdge,
  SwitchTemplateNode,
  TemplateNode,
  TemplateNodeImageStrategy,
} from '../../../lib/scenario-graph';
import { compileTopologyGraph } from '../../../lib/template-compiler';
import { syncTopologySpecFromNodes } from '../../../lib/template-topology-sync';
import { useAdminSession } from '../use-admin-session';
import { readTopologyViewport, writeTopologyViewport } from './topology-flow-adapter';
import {
  createTopologyHistory,
  pushTopologySnapshot,
  redoTopology,
  undoTopology,
  type TopologyHistory,
} from './topology-flow-history';
import { layoutTopology } from './topology-flow-layout';
import { TopologyFlowCanvas } from './topology-flow-canvas';
import type {
  TopologySelection,
  TopologySnapshot,
  TopologyViewport,
} from './topology-flow-types';

type TemplateEditorScreenProps = {
  templateId?: string;
  apiBaseUrl?: string;
  template?: RangeTemplate;
};

type DraftTopologyGraph = ScenarioGraphDraft & { viewport?: TopologyViewport };
export type TemplateEdge = ScenarioGraphEdge;
type TemplateEditorEcsNode = EcsTemplateNode & { platformImageAssetId?: string };
const SCENARIO_GRAPH_SCHEMA_VERSION = '2.0.0';
const DEFAULT_SWITCH_CIDRS = ['10.0.0.0/24', '192.168.0.0/24', '172.16.0.0/24'] as const;
const TOPOLOGY_CACHE_PREFIX = 'template-editor:topology-cache';
const NEW_TEMPLATE_SESSION_KEY = 'template-editor:new-template';

type TopologyCachePayload = {
  topologyGraph: DraftTopologyGraph;
  persistedGraphSignature: string;
};

function TemplatePropertyPanelPlaceholder() {
  return (
    <aside className="template-editor-panel template-property-panel">
      <div className="admin-section-header template-property-panel-header">
        <h2>属性面板</h2>
      </div>

      <div className="template-property-shell">
        <div className="template-property-placeholder">
          <strong>选择节点后配置</strong>
        </div>
      </div>
    </aside>
  );
}

function TemplateEditorLoadingState() {
  return (
    <section aria-busy="true" className="template-editor-screen">
      <span aria-label="正在加载靶场编排页" className="sr-only" role="status">
        正在加载靶场编排页
      </span>
      <div className="template-editor-toolbar admin-workbench-surface">
        <div className="template-editor-toolbar-copy">
          <h1>正在加载靶场编排页...</h1>
          <p className="template-editor-toolbar-status">正在读取当前拓扑</p>
        </div>
        <div aria-hidden="true" className="flex gap-2">
          <div className="h-8 w-20 animate-pulse rounded-md bg-muted" />
          <div className="h-8 w-24 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
      <div className="template-editor-grid" data-testid="template-editor-loading-grid">
        <aside className="template-editor-panel">
          <div className="admin-section-header">
            <h2>资源面板</h2>
          </div>
          <div className="space-y-3">
            <div className="h-14 animate-pulse rounded-md bg-muted" />
            <div className="h-14 animate-pulse rounded-md bg-muted" />
            <div className="h-14 animate-pulse rounded-md bg-muted" />
          </div>
        </aside>
        <section className="template-editor-panel">
          <div className="admin-section-header">
            <h2>拓扑画布</h2>
          </div>
          <div className="h-[calc(100%-3rem)] min-h-72 animate-pulse rounded-md bg-muted/70" />
        </section>
        <aside className="template-editor-panel template-property-panel">
          <div className="admin-section-header template-property-panel-header">
            <h2>属性面板</h2>
          </div>
          <div className="template-property-shell">
            <div className="space-y-3 p-3">
              <div className="h-4 w-2/5 animate-pulse rounded-sm bg-muted" />
              <div className="h-8 animate-pulse rounded-md bg-muted" />
              <div className="h-8 animate-pulse rounded-md bg-muted" />
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

const TemplatePropertyPanel = dynamic(
  () => import('./template-property-panel').then(({ TemplatePropertyPanel: Component }) => Component),
  {
    ssr: false,
    loading: TemplatePropertyPanelPlaceholder,
  },
);

function applyEconomyInstanceType(
  node: Pick<EcsTemplateNode, 'cpu' | 'memory' | 'instanceType' | 'instanceTypeStrategy'>,
  options?: { preserveExisting?: boolean },
): Pick<EcsTemplateNode, 'instanceType' | 'instanceTypeStrategy'> {
  const preferredInstanceTypes = resolvePreferredInstanceTypes(node.cpu, node.memory);
  const instanceType = preferredInstanceTypes[0];
  const configuredInstanceType =
    readConfiguredInstanceType(node.instanceTypeStrategy.instanceType) ?? readConfiguredInstanceType(node.instanceType);

  if (!instanceType) {
    if (options?.preserveExisting && configuredInstanceType) {
      return {
        instanceType: configuredInstanceType,
        instanceTypeStrategy: {
          mode: 'fixed',
          instanceType: configuredInstanceType,
        },
      };
    }

    return {
      instanceType: undefined,
      instanceTypeStrategy: {
        mode: 'auto',
        preferredInstanceTypes: [],
      },
    };
  }

  if (
    options?.preserveExisting &&
    node.instanceTypeStrategy.mode === 'fixed' &&
    configuredInstanceType
  ) {
    return {
      instanceType: configuredInstanceType,
      instanceTypeStrategy: {
        mode: 'fixed',
        instanceType: configuredInstanceType,
      },
    };
  }

  return {
    instanceType,
    instanceTypeStrategy: {
      mode: 'prefer-list',
      preferredInstanceTypes: [...preferredInstanceTypes],
    },
  };
}

function readConfiguredInstanceType(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readFinalInstanceType(node: Pick<EcsTemplateNode, 'cpu' | 'memory' | 'instanceType' | 'instanceTypeStrategy'>) {
  return (
    readConfiguredInstanceType(node.instanceType) ??
    readConfiguredInstanceType(node.instanceTypeStrategy.instanceType) ??
    resolveFixedInstanceType(node.cpu, node.memory)
  );
}

function readTopologyCacheKey(template: RangeTemplate | null | undefined, fallbackTemplateId?: string) {
  const resolvedTemplateId = template?.id ?? fallbackTemplateId ?? null;
  const revision = template?.revision ?? null;

  if (!resolvedTemplateId || revision === null) {
    return null;
  }

  return `${TOPOLOGY_CACHE_PREFIX}:${resolvedTemplateId}:${revision}`;
}

function readTopologyGraphFromCache(
  cacheKey: string | null,
  currentPersistedGraphSignature: string,
): DraftTopologyGraph | null {
  if (!cacheKey || typeof window === 'undefined' || typeof window.localStorage?.getItem !== 'function') {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(cacheKey);

    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as
      | TopologyCachePayload
      | Partial<DraftTopologyGraph>
      | null;

    if (!parsedValue || typeof parsedValue !== 'object') {
      return null;
    }

    if ('topologyGraph' in parsedValue) {
      const topologyGraph =
        parsedValue.topologyGraph && typeof parsedValue.topologyGraph === 'object'
          ? (parsedValue.topologyGraph as Partial<DraftTopologyGraph>)
          : null;

      if (
        !topologyGraph ||
        !Array.isArray(topologyGraph.nodes) ||
        !Array.isArray(topologyGraph.edges) ||
        parsedValue.persistedGraphSignature !== currentPersistedGraphSignature
      ) {
        window.localStorage.removeItem(cacheKey);
        return null;
      }

      return {
        schemaVersion:
          typeof topologyGraph.schemaVersion === 'string'
            ? topologyGraph.schemaVersion
            : SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes: topologyGraph.nodes as DraftTopologyGraph['nodes'],
        edges: topologyGraph.edges as DraftTopologyGraph['edges'],
        ...(readTopologyViewport(topologyGraph.viewport)
          ? { viewport: readTopologyViewport(topologyGraph.viewport)! }
          : {}),
      };
    }

    // ponytail: invalidate legacy cache payloads after the cache format upgrade so stale local graphs
    // cannot override newer server-side template changes.
    window.localStorage.removeItem(cacheKey);
    return null;
  } catch {
    return null;
  }
}

function writeTopologyGraphToCache(
  cacheKey: string | null,
  topologyGraph: DraftTopologyGraph,
  persistedGraphSignature: string,
) {
  if (!cacheKey || typeof window === 'undefined' || typeof window.localStorage?.setItem !== 'function') {
    return;
  }

  window.localStorage.setItem(
    cacheKey,
    JSON.stringify({
      topologyGraph,
      persistedGraphSignature,
    } satisfies TopologyCachePayload),
  );
}

function removeTopologyGraphCache(cacheKey: string | null) {
  if (!cacheKey || typeof window === 'undefined' || typeof window.localStorage?.removeItem !== 'function') {
    return;
  }

  window.localStorage.removeItem(cacheKey);
}

function readTemplateTopologyGraph(template: RangeTemplate | null) {
  const topologyGraph = template?.topologyGraph;
  return topologyGraph && typeof topologyGraph === 'object' ? topologyGraph : null;
}

function readResolvedTopologyGraph(template: RangeTemplate | null, fallbackTemplateId?: string) {
  const persistedTopologyGraph = readTemplateTopologyGraph(template);
  const currentPersistedGraphSignature = readGraphSignature(
    persistedTopologyGraph && typeof persistedTopologyGraph === 'object' && Array.isArray((persistedTopologyGraph as { nodes?: unknown }).nodes)
      ? readNodesFromRawTopologyGraph(persistedTopologyGraph)
      : [],
    persistedTopologyGraph && typeof persistedTopologyGraph === 'object' && Array.isArray((persistedTopologyGraph as { edges?: unknown }).edges)
      ? readEdgesFromRawTopologyGraph(persistedTopologyGraph)
      : [],
  );

  return (
    readTopologyGraphFromCache(readTopologyCacheKey(template, fallbackTemplateId), currentPersistedGraphSignature) ??
    persistedTopologyGraph
  );
}

function readGraphSignature(nodes: TemplateNode[], edges: TemplateEdge[]) {
  return JSON.stringify({ nodes, edges });
}

function readNodesFromRawTopologyGraph(topologyGraph: Record<string, unknown>) {
  const rawNodes = (topologyGraph as { nodes?: unknown }).nodes;
  return Array.isArray(rawNodes) ? (rawNodes as TemplateNode[]) : [];
}

function readEdgesFromRawTopologyGraph(topologyGraph: Record<string, unknown>) {
  const rawEdges = (topologyGraph as { edges?: unknown }).edges;
  return Array.isArray(rawEdges) ? (rawEdges as TemplateEdge[]) : [];
}

function readViewportFromTemplate(template: RangeTemplate | null, fallbackTemplateId?: string) {
  const topologyGraph = readResolvedTopologyGraph(template, fallbackTemplateId);

  return topologyGraph && typeof topologyGraph === 'object'
    ? readTopologyViewport((topologyGraph as { viewport?: unknown }).viewport)
    : null;
}

function parseIpv4ToNumber(value: string) {
  const octets = value.split('.').map((item) => Number(item));

  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return null;
  }

  return (((octets[0]! << 24) >>> 0) + ((octets[1]! << 16) >>> 0) + ((octets[2]! << 8) >>> 0) + (octets[3] ?? 0)) >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string) {
  const [networkIp = '', prefixText = ''] = cidr.split('/');
  const ipNumber = parseIpv4ToNumber(ip);
  const networkNumber = parseIpv4ToNumber(networkIp);
  const prefix = Number(prefixText);

  if (ipNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function isCompleteIpv4(value: string) {
  return parseIpv4ToNumber(value) !== null;
}

function readStoredPosition(
  value: unknown,
  fallbackPosition: { x: number; y: number },
) {
  if (!value || typeof value !== 'object') {
    return fallbackPosition;
  }

  const candidate = value as { x?: unknown; y?: unknown };

  return {
    x: typeof candidate.x === 'number' ? candidate.x : fallbackPosition.x,
    y: typeof candidate.y === 'number' ? candidate.y : fallbackPosition.y,
  };
}

function isDraftBlueprintComplete(topologySpec: ReturnType<typeof syncTopologySpecFromNodes>) {
  return (
    topologySpec.networkZones.length > 0 &&
    topologySpec.hosts.length > 0 &&
    topologySpec.publicEntry.hostKey.trim().length > 0 &&
    topologySpec.publicEntry.protocols.length > 0
  );
}

function readDefaultSwitchCidr(ordinal: number) {
  return DEFAULT_SWITCH_CIDRS[ordinal - 1] ?? `10.${Math.max(ordinal - 3, 1)}.0.0/24`;
}

function readDefaultNodeLabel(kind: TemplateNode['kind'], ordinal: number) {
  if (kind === 'router') {
    return 'Router';
  }

  if (kind === 'switch') {
    return `交换机 ${ordinal}`;
  }

  return `ECS ${ordinal}`;
}

function createNodePosition(kind: TemplateNode['kind'], ordinal: number) {
  const columnX =
    kind === 'router'
      ? 120
      : kind === 'switch'
        ? 360
        : 620;
  const rowOffset = Math.floor(Math.max(ordinal - 1, 0) / 3) * 150;
  const staggerOffset = ((Math.max(ordinal - 1, 0) % 3) - 1) * 24;

  return {
    x: columnX,
    y: 180 + rowOffset + staggerOffset,
  };
}

function createDefaultEcsNode(
  id: string,
  label: string,
  zoneKey: string,
  privateIp: string,
  exposePublic: boolean,
  ordinal: number,
): EcsTemplateNode {
  return {
    id,
    kind: 'ecs',
    label,
    position: createNodePosition('ecs', ordinal),
    instanceName: label,
    hostName: `ecs-${ordinal}`,
    zoneKey,
    role: 'host',
    privateIp,
    customPassword: '',
    exposePublic,
    image: '',
    imageName: '',
    imageId: '',
    cpu: 2,
    memory: 2,
    description: '',
    bootPriority: 1,
    bootWaitSeconds: 0,
    dnatMappings: [],
    networkInterfaces: [{ zoneKey, privateIp }],
    portGroups: [],
    nics: [
      {
        id: `${id}-nic-1`,
        switchId: '',
        privateIp,
        secondaryIps: [],
        securityGroupRules: [],
      },
    ],
    initScript: '',
    imageStrategy: {
      mode: 'fixed',
    },
    ...applyEconomyInstanceType({
      cpu: 2,
      memory: 2,
      instanceTypeStrategy: {
        mode: 'auto',
        preferredInstanceTypes: [],
      },
    }),
  };
}

function createDefaultSwitchNode(id: string, label: string, zoneKey: string, cidr: string, ordinal: number): SwitchTemplateNode {
  return {
    id,
    kind: 'switch',
    label,
    position: createNodePosition('switch', ordinal),
    zoneKey,
    cidr,
    purpose: 'business-zone',
    description: '',
    aclRules: [],
    nat: {
      snatEnabled: false,
      dnatMappings: [],
    },
  };
}

function normalizeImageStrategy(
  value: unknown,
  fallbackImageId: string,
): TemplateNodeImageStrategy {
  if (value && typeof value === 'object' && 'mode' in value) {
    const candidate = value as Record<string, unknown>;

    if (
      candidate.mode === 'fixed' ||
      candidate.mode === 'auto' ||
      candidate.mode === 'prefer-list'
    ) {
      return {
        mode: candidate.mode,
        ...(typeof candidate.imageId === 'string' ? { imageId: candidate.imageId } : {}),
        ...(Array.isArray(candidate.preferredImageIds)
          ? { preferredImageIds: candidate.preferredImageIds.filter((item): item is string => typeof item === 'string') }
          : {}),
      };
    }
  }

  return {
    mode: 'fixed',
    imageId: fallbackImageId,
  };
}

function normalizeInstanceTypeStrategy(
  value: unknown,
  cpu?: number,
  memory?: number,
  persistedInstanceType?: unknown,
): Pick<EcsTemplateNode, 'instanceType' | 'instanceTypeStrategy'> {
  const normalizedPersistedInstanceType = readConfiguredInstanceType(persistedInstanceType);

  if (value && typeof value === 'object' && 'mode' in value) {
    const candidate = value as Record<string, unknown>;

    if (
      candidate.mode === 'fixed' ||
      candidate.mode === 'auto' ||
      candidate.mode === 'prefer-family' ||
      candidate.mode === 'prefer-list'
    ) {
      const strategyInstanceType = readConfiguredInstanceType(candidate.instanceType);
      const preferredInstanceTypes = Array.isArray(candidate.preferredInstanceTypes)
        ? candidate.preferredInstanceTypes.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          )
        : [];

      if (candidate.mode === 'fixed') {
        const fixedInstanceType = strategyInstanceType ?? normalizedPersistedInstanceType;

        if (fixedInstanceType) {
          return {
            instanceType: fixedInstanceType,
            instanceTypeStrategy: {
              mode: 'fixed',
              instanceType: fixedInstanceType,
            },
          };
        }
      }

      if (candidate.mode === 'prefer-list' && preferredInstanceTypes.length > 0) {
        return {
          ...(strategyInstanceType || normalizedPersistedInstanceType
            ? { instanceType: strategyInstanceType ?? normalizedPersistedInstanceType }
            : {}),
          instanceTypeStrategy: {
            mode: 'prefer-list',
            preferredInstanceTypes,
          },
        };
      }

      if (candidate.mode === 'prefer-family') {
        return {
          ...(strategyInstanceType ? { instanceType: strategyInstanceType } : {}),
          instanceTypeStrategy: {
            mode: 'prefer-family',
            ...(strategyInstanceType ? { instanceType: strategyInstanceType } : {}),
          },
        };
      }
    }
  }

  if (normalizedPersistedInstanceType) {
    return {
      instanceType: normalizedPersistedInstanceType,
      instanceTypeStrategy: {
        mode: 'fixed',
        instanceType: normalizedPersistedInstanceType,
      },
    };
  }

  const preferredInstanceTypes = resolvePreferredInstanceTypes(cpu, memory);

  if (preferredInstanceTypes.length > 0) {
    return {
      instanceType: preferredInstanceTypes[0],
      instanceTypeStrategy: {
        mode: 'prefer-list',
        preferredInstanceTypes: [...preferredInstanceTypes],
      },
    };
  }

  return {
    instanceType: undefined,
    instanceTypeStrategy: {
      mode: 'auto',
      preferredInstanceTypes: [],
    },
  };
}

function filterPhaseOneNodes(nodes: TemplateNode[]): TemplateNode[] {
  return nodes.filter((node) => isPhaseOneNodeKindTypeGuard(node.kind));
}

function syncHostNicsWithLinkedSwitch(
  hostNode: EcsTemplateNode,
  switchNode: SwitchTemplateNode,
): EcsTemplateNode {
  const existingNics = hostNode.nics && hostNode.nics.length > 0
    ? hostNode.nics
    : [
        {
          id: `${hostNode.id}-nic-1`,
          switchId: '',
          privateIp: '',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ];

  if (existingNics.some((nic) => nic.switchId === switchNode.id)) {
    return hostNode;
  }

  const emptyNicIndex = existingNics.findIndex((nic) => !nic.switchId);

  if (emptyNicIndex >= 0) {
    return {
      ...hostNode,
      nics: existingNics.map((nic, index) =>
        index === emptyNicIndex
          ? {
              ...nic,
              switchId: switchNode.id,
            }
          : nic,
      ),
    };
  }

  return {
    ...hostNode,
    nics: [
      ...existingNics,
      {
        id: `${hostNode.id}-nic-${existingNics.length + 1}`,
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
        nics: (node.nics ?? []).map((nic) =>
          nic.switchId === deletedNode.id
            ? {
                ...nic,
                switchId: '',
              }
            : nic,
        ),
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

function cleanupEdgeReferencesAfterDeletion(
  nodes: TemplateNode[],
  deletedEdge: TemplateEdge,
) {
  const sourceNode = nodes.find((node) => node.id === deletedEdge.fromNodeId) ?? null;
  const targetNode = nodes.find((node) => node.id === deletedEdge.toNodeId) ?? null;

  const switchNode =
    sourceNode?.kind === 'switch'
      ? sourceNode
      : targetNode?.kind === 'switch'
        ? targetNode
        : null;
  const hostNode =
    sourceNode?.kind === 'ecs'
      ? sourceNode
      : targetNode?.kind === 'ecs'
        ? targetNode
        : null;

  if (!switchNode || !hostNode) {
    return nodes;
  }

  return nodes.map((node) =>
    node.id === hostNode.id && node.kind === 'ecs'
      ? {
          ...node,
          nics: (node.nics ?? []).map((nic) =>
            nic.switchId === switchNode.id
              ? {
                  ...nic,
                  switchId: '',
                }
              : nic,
          ),
        }
      : node,
  );
}

function readPublishErrorMessage(error: unknown) {
  if (error instanceof AdminApiError) {
    const details = error.details;

    if (details && typeof details === 'object' && 'message' in details) {
      const message = (details as { message?: unknown }).message;

      if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
        return `编排发布失败：${message.join('；')}`;
      }

      if (typeof message === 'string' && message.trim().length > 0) {
        return `编排发布失败：${message}`;
      }
    }

    if (error.message.trim().length > 0) {
      return `编排发布失败：${error.message}`;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return `编排发布失败：${error.message}`;
  }

  return '编排发布失败，请检查拓扑与编译结果';
}

function buildScenarioTemplateMetadata(template: RangeTemplate): ScenarioTemplateMetadata {
  return {
    name: template.name ?? template.slug,
    slug: template.slug,
    version: 'v1',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
  };
}

function readNewTemplateSession(): RangeTemplate {
  let seed: { name?: unknown; description?: unknown } = {};

  if (typeof window !== 'undefined') {
    try {
      seed = JSON.parse(window.sessionStorage.getItem(NEW_TEMPLATE_SESSION_KEY) ?? '{}') as typeof seed;
    } catch {
      seed = {};
    }
  }

  return {
    id: 'new',
    name: typeof seed.name === 'string' && seed.name.trim() ? seed.name.trim() : '未命名拓扑',
    description: typeof seed.description === 'string' ? seed.description.trim() : '',
    slug: 'new-template',
    visibility: 'private',
    status: 'private',
    revision: 0,
    topologyGraph: {
      schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
      nodes: [],
      edges: [],
    },
  };
}

function readInitialTemplate(
  providedTemplate: RangeTemplate | undefined,
  templateId: string | undefined,
) {
  if (providedTemplate) {
    return providedTemplate;
  }

  return templateId === 'new' ? readNewTemplateSession() : null;
}

function readPersistTopologyErrorMessage(error: unknown) {
  if (error instanceof AdminApiError) {
    const details = error.details;

    if (details && typeof details === 'object' && 'message' in details) {
      const message = (details as { message?: unknown }).message;

      if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
        return `拓扑保存失败：${message.join('；')}`;
      }

      if (typeof message === 'string' && message.trim().length > 0) {
        return `拓扑保存失败：${message}`;
      }
    }

    if (error.message.trim().length > 0) {
      return `拓扑保存失败：${error.message}`;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.startsWith('拓扑检测未通过')
      ? error.message
      : `拓扑保存失败：${error.message}`;
  }

  return '拓扑保存失败，请稍后重试';
}

function readInvalidCustomPasswordMessage(nodes: TemplateNode[]) {
  for (const node of nodes) {
    if (node.kind !== 'ecs' || typeof node.customPassword !== 'string' || node.customPassword.length === 0) {
      continue;
    }

    const validationResult = validateAliyunEcsPassword(node.customPassword);

    if (!validationResult.valid && validationResult.message) {
      return `${node.label} 自定义密码不合法：${validationResult.message}`;
    }
  }

  return null;
}

function readNodesFromTemplate(template: RangeTemplate | null, fallbackTemplateId?: string): TemplateNode[] {
  const topologyGraph = readResolvedTopologyGraph(template, fallbackTemplateId);
  const rawNodes = topologyGraph && typeof topologyGraph === 'object' ? (topologyGraph as { nodes?: unknown }).nodes : [];

  if (!Array.isArray(rawNodes)) {
    return [];
  }

  const kindCounts: Record<TemplateNode['kind'], number> = {
    router: 0,
    switch: 0,
    ecs: 0,
  };

  const parsedNodes = rawNodes
    .map<TemplateNode | null>((node, index) => {
      if (!node || typeof node !== 'object') {
        return null;
      }

      const candidate = node as Partial<TemplateNode> & { id?: unknown; kind?: unknown; label?: unknown };
      const candidateRecord = node as Record<string, unknown>;
      const kind =
        typeof candidate.kind === 'undefined'
          ? 'ecs'
          : isPhaseOneNodeKindTypeGuard(candidate.kind)
            ? candidate.kind
            : null;

      if (!kind) {
        return null;
      }

      kindCounts[kind] += 1;
      const kindOrdinal = kindCounts[kind];

      if (kind === 'switch') {
        const defaultNode = createDefaultSwitchNode(
          typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          typeof candidate.label === 'string' ? candidate.label : readDefaultNodeLabel('switch', kindOrdinal),
          typeof candidateRecord.zoneKey === 'string' ? candidateRecord.zoneKey : `zone-${kindOrdinal}`,
          typeof candidateRecord.cidr === 'string' ? candidateRecord.cidr : readDefaultSwitchCidr(kindOrdinal),
          kindOrdinal,
        );

        return {
          ...defaultNode,
          position: readStoredPosition(
            candidateRecord.position,
            defaultNode.position ?? createNodePosition('switch', kindOrdinal),
          ),
          purpose: typeof candidateRecord.purpose === 'string' ? candidateRecord.purpose : 'business-zone',
          description: typeof candidateRecord.description === 'string' ? candidateRecord.description : '',
          aclRules: Array.isArray(candidateRecord.aclRules) ? candidateRecord.aclRules as SwitchTemplateNode['aclRules'] : [],
          nat:
            candidateRecord.nat && typeof candidateRecord.nat === 'object'
              ? {
                  snatEnabled:
                    typeof (candidateRecord.nat as Record<string, unknown>).snatEnabled === 'boolean'
                      ? ((candidateRecord.nat as Record<string, unknown>).snatEnabled as boolean)
                      : false,
                  dnatMappings: Array.isArray((candidateRecord.nat as Record<string, unknown>).dnatMappings)
                    ? ((candidateRecord.nat as Record<string, unknown>).dnatMappings as NonNullable<SwitchTemplateNode['nat']>['dnatMappings'])
                    : [],
                }
              : {
                  snatEnabled: typeof candidateRecord.snatEnabled === 'boolean' ? candidateRecord.snatEnabled : false,
                  dnatMappings: [],
                },
        } satisfies TemplateNode;
      }

      if (kind === 'router') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'router',
          label: typeof candidate.label === 'string' ? candidate.label : readDefaultNodeLabel('router', kindOrdinal),
          position:
            candidateRecord.position && typeof candidateRecord.position === 'object'
              ? candidateRecord.position as { x: number; y: number }
              : { x: 120, y: 220 },
          description: typeof candidateRecord.description === 'string' ? candidateRecord.description : '',
          routeRole: typeof candidateRecord.routeRole === 'string' ? candidateRecord.routeRole : 'egress',
          egressType: typeof candidateRecord.egressType === 'string' ? candidateRecord.egressType : 'internet',
          bindEip: typeof candidateRecord.bindEip === 'boolean' ? candidateRecord.bindEip : false,
        } satisfies TemplateNode;
      }

      const defaultNode = createDefaultEcsNode(
        typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
        typeof candidate.label === 'string' ? candidate.label : readDefaultNodeLabel('ecs', kindOrdinal),
        typeof candidateRecord.zoneKey === 'string' ? candidateRecord.zoneKey : 'core',
        typeof candidateRecord.privateIp === 'string' ? candidateRecord.privateIp : '',
        typeof candidateRecord.exposePublic === 'boolean' ? candidateRecord.exposePublic : false,
        kindOrdinal,
      );

      return {
        ...defaultNode,
        position: readStoredPosition(
          candidateRecord.position,
          defaultNode.position ?? createNodePosition('ecs', kindOrdinal),
        ),
        instanceName:
          typeof candidateRecord.instanceName === 'string'
            ? candidateRecord.instanceName
            : readDefaultNodeLabel('ecs', kindOrdinal),
        hostName: typeof candidateRecord.hostName === 'string' ? candidateRecord.hostName : `ecs-${kindOrdinal}`,
        role: typeof candidateRecord.role === 'string' ? candidateRecord.role : 'ecs',
        customPassword: typeof candidateRecord.customPassword === 'string' ? candidateRecord.customPassword : '',
        image: typeof candidateRecord.image === 'string' ? candidateRecord.image : '',
        platformImageAssetId:
          typeof candidateRecord.platformImageAssetId === 'string' ? candidateRecord.platformImageAssetId : undefined,
        imageName: typeof candidateRecord.imageName === 'string' ? candidateRecord.imageName : (typeof candidateRecord.image === 'string' ? candidateRecord.image : ''),
        imageId: typeof candidateRecord.imageId === 'string' ? candidateRecord.imageId : (typeof candidateRecord.image === 'string' ? candidateRecord.image : ''),
        cpu: typeof candidateRecord.cpu === 'number' ? candidateRecord.cpu : 1,
        memory: typeof candidateRecord.memory === 'number' ? candidateRecord.memory : 2,
        description: typeof candidateRecord.description === 'string' ? candidateRecord.description : '',
        bootPriority: typeof candidateRecord.bootPriority === 'number' ? candidateRecord.bootPriority : 1,
        bootWaitSeconds: typeof candidateRecord.bootWaitSeconds === 'number' ? candidateRecord.bootWaitSeconds : 0,
        dnatMappings: Array.isArray(candidateRecord.dnatMappings) ? candidateRecord.dnatMappings : [],
        networkInterfaces: Array.isArray(candidateRecord.networkInterfaces)
          ? candidateRecord.networkInterfaces
          : [
              {
                zoneKey: typeof candidateRecord.zoneKey === 'string' ? candidateRecord.zoneKey : 'core',
                privateIp: typeof candidateRecord.privateIp === 'string' ? candidateRecord.privateIp : '',
              },
            ],
        portGroups: Array.isArray(candidateRecord.portGroups) ? candidateRecord.portGroups : [],
        nics: Array.isArray(candidateRecord.nics)
          ? candidateRecord.nics as EcsTemplateNode['nics']
          : [
              {
                id: `${typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`}-nic-1`,
                switchId:
                  typeof candidateRecord.switchId === 'string'
                    ? candidateRecord.switchId
                    : '',
                privateIp:
                  typeof candidateRecord.privateIp === 'string' ? candidateRecord.privateIp : '',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
        initScript: typeof candidateRecord.initScript === 'string' ? candidateRecord.initScript : '',
        imageStrategy: normalizeImageStrategy(
          candidateRecord.imageStrategy,
          typeof candidateRecord.image === 'string'
            ? candidateRecord.image
            : '',
        ),
        ...normalizeInstanceTypeStrategy(
          candidateRecord.instanceTypeStrategy,
          typeof candidateRecord.cpu === 'number' ? candidateRecord.cpu : 1,
          typeof candidateRecord.memory === 'number' ? candidateRecord.memory : 2,
          candidateRecord.instanceType,
        ),
      } satisfies TemplateEditorEcsNode;
    })
    .filter((node): node is TemplateNode => node !== null);

  return filterPhaseOneNodes(parsedNodes);
}

function readEdgesFromTemplate(template: RangeTemplate | null, fallbackTemplateId?: string): TemplateEdge[] {
  const topologyGraph = readResolvedTopologyGraph(template, fallbackTemplateId);
  const rawEdges = topologyGraph && typeof topologyGraph === 'object' ? (topologyGraph as { edges?: unknown }).edges : [];

  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges
    .map((edge, index) => {
      if (!edge || typeof edge !== 'object') {
        return null;
      }

      const candidate = edge as Record<string, unknown>;

      if (typeof candidate.fromNodeId !== 'string' || typeof candidate.toNodeId !== 'string') {
        return null;
      }

      return {
        id: typeof candidate.id === 'string' ? candidate.id : `edge-${index + 1}`,
        fromNodeId: candidate.fromNodeId,
        toNodeId: candidate.toNodeId,
        relationType: 'manual' as const,
        ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      } satisfies TemplateEdge;
    })
    .filter((edge): edge is TemplateEdge => edge !== null);
}

export function TemplateEditorScreen({
  templateId,
  apiBaseUrl = 'http://localhost:3001',
  template: providedTemplate,
}: TemplateEditorScreenProps) {
  const session = useAdminSession();
  const router = useRouter();
  const [template, setTemplate] = useState<RangeTemplate | null>(() =>
    readInitialTemplate(providedTemplate, templateId),
  );
  const [nodes, setNodes] = useState<TemplateNode[]>(() =>
    readNodesFromTemplate(readInitialTemplate(providedTemplate, templateId), templateId),
  );
  const [edges, setEdges] = useState<TemplateEdge[]>(() =>
    readEdgesFromTemplate(readInitialTemplate(providedTemplate, templateId), templateId),
  );
  const [viewport, setViewport] = useState<TopologyViewport | null>(() =>
    readViewportFromTemplate(readInitialTemplate(providedTemplate, templateId), templateId),
  );
  const [selection, setSelection] = useState<TopologySelection>({ nodeIds: [], edgeIds: [] });
  const [isPropertyPanelOpen, setIsPropertyPanelOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [platformImageAssets, setPlatformImageAssets] = useState<PlatformImageAsset[]>([]);
  const [instanceTypeAvailability, setInstanceTypeAvailability] = useState<InstanceTypeAvailabilitySnapshot | null>(
    null,
  );
  const topologyCacheKey = useMemo(() => readTopologyCacheKey(template, templateId), [template, templateId]);
  const graphSignature = useMemo(() => readGraphSignature(nodes, edges), [edges, nodes]);
  const lastPersistedGraphRef = useRef(
    readGraphSignature(
      readNodesFromTemplate(readInitialTemplate(providedTemplate, templateId), templateId),
      readEdgesFromTemplate(readInitialTemplate(providedTemplate, templateId), templateId),
    ),
  );
  const instanceTypeAvailabilityRequestRef = useRef(0);
  const historyRef = useRef<TopologyHistory | null>(null);

  if (!historyRef.current) {
    historyRef.current = createTopologyHistory({ nodes, edges, viewport });
  }

  const [, setHistoryState] = useState<TopologyHistory>(historyRef.current);

  function applyTemplateState(nextTemplate: RangeTemplate | null) {
    const nextNodes = readNodesFromTemplate(nextTemplate, templateId);
    const nextEdges = readEdgesFromTemplate(nextTemplate, templateId);
    const nextViewport = readViewportFromTemplate(nextTemplate, templateId);
    setTemplate(nextTemplate);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setViewport(nextViewport);
    setSelection({ nodeIds: [], edgeIds: [] });
    setIsPropertyPanelOpen(false);
    lastPersistedGraphRef.current = readGraphSignature(nextNodes, nextEdges);
    historyRef.current = createTopologyHistory({
      nodes: nextNodes,
      edges: nextEdges,
      viewport: nextViewport,
    });
    setHistoryState(historyRef.current);
  }

  function buildDraftUpdatePayload(
    currentNodes: TemplateNode[],
    currentEdges: TemplateEdge[],
    currentViewport: TopologyViewport | null,
  ) {
    return {
      topologyGraph: writeTopologyViewport({
        schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes: currentNodes,
        edges: currentEdges,
      } satisfies ScenarioGraphDraft, currentViewport) satisfies DraftTopologyGraph,
    };
  }

  function normalizeNodesForValidatedPayload(currentNodes: TemplateNode[]) {
    return currentNodes.map((node) =>
      node.kind === 'ecs'
        ? {
            ...node,
            ...applyEconomyInstanceType(node, {
              preserveExisting: true,
            }),
          }
        : node,
    );
  }

  function buildValidatedDraftPayload(
    currentTemplate: RangeTemplate,
    currentNodes: TemplateNode[],
    currentEdges: TemplateEdge[],
    currentViewport: TopologyViewport | null,
  ) {
    const normalizedNodes = normalizeNodesForValidatedPayload(currentNodes);
    const graphPayload = buildDraftUpdatePayload(normalizedNodes, currentEdges, currentViewport);
    const topologyGraph = graphPayload.topologyGraph;
    const switchNodes = normalizedNodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch');
    const hostNodes = normalizedNodes.filter((node): node is EcsTemplateNode => node.kind === 'ecs');
    const switchById = new Map(switchNodes.map((node) => [node.id, node]));
    const nicIpUsage = new Map<string, string>();
    const validationErrors: string[] = [];

    function registerNicIpUsage(
      linkedSwitch: SwitchTemplateNode | null,
      ipValue: string,
      usageLabel: string,
    ) {
      const normalizedIp = ipValue.trim();

      if (!linkedSwitch || !normalizedIp || !isCompleteIpv4(normalizedIp)) {
        return;
      }

      const usageKey = `${linkedSwitch.id}:${normalizedIp}`;
      const existingUsage = nicIpUsage.get(usageKey);

      if (existingUsage) {
        validationErrors.push(
          `${linkedSwitch.label} 中存在重复 IP：${normalizedIp}（${existingUsage}、${usageLabel}）`,
        );
        return;
      }

      nicIpUsage.set(usageKey, usageLabel);
    }

    if (switchNodes.length === 0) {
      validationErrors.push('至少需要一个交换机');
    }

    if (hostNodes.length === 0) {
      validationErrors.push('至少需要一个 ECS 主机');
    }

    for (const hostNode of hostNodes) {
      if (typeof hostNode.customPassword === 'string' && hostNode.customPassword.length > 0) {
        const passwordValidationResult = validateAliyunEcsPassword(hostNode.customPassword);

        if (!passwordValidationResult.valid && passwordValidationResult.message) {
          validationErrors.push(`${hostNode.label} 自定义密码不合法：${passwordValidationResult.message}`);
        }
      }

      if (!hostNode.platformImageAssetId?.trim() || !hostNode.imageId?.trim()) {
        validationErrors.push(`${hostNode.label} 请选择镜像`);
      }

      const nics = hostNode.nics ?? [];

      if (nics.length === 0) {
        validationErrors.push(`${hostNode.label} 缺少网卡配置`);
        continue;
      }

      nics.forEach((nic, index) => {
        const nicIndex = `网卡 ${index + 1}`;
        const linkedSwitch = nic.switchId ? switchById.get(nic.switchId) ?? null : null;

        if (!nic.switchId) {
          validationErrors.push(`${hostNode.label} 的${nicIndex}未绑定交换机`);
        } else if (!linkedSwitch) {
          validationErrors.push(`${hostNode.label} 的${nicIndex}绑定了不存在的交换机`);
        }

        if (!nic.privateIp.trim()) {
          validationErrors.push(`${hostNode.label} 的${nicIndex}未填写私网 IP`);
        } else if (linkedSwitch && !isIpv4InCidr(nic.privateIp, linkedSwitch.cidr)) {
          validationErrors.push(`${hostNode.label} 的${nicIndex}私网 IP 不在 ${linkedSwitch.cidr} 网段内`);
        }

        registerNicIpUsage(linkedSwitch, nic.privateIp, `${hostNode.label} 的${nicIndex}私网 IP`);

        nic.secondaryIps.forEach((secondaryIp, secondaryIndex) => {
          const secondaryLabel = `${hostNode.label} 的${nicIndex}辅助 IP ${secondaryIndex + 1}`;

          if (linkedSwitch && secondaryIp.trim() && !isIpv4InCidr(secondaryIp, linkedSwitch.cidr)) {
            validationErrors.push(`${secondaryLabel} 不在 ${linkedSwitch.cidr} 网段内`);
          }

          registerNicIpUsage(linkedSwitch, secondaryIp, secondaryLabel);
        });
      });
    }

    findDuplicateDnatExternalPorts(normalizedNodes).forEach((conflict) => {
      validationErrors.push(
        `DNAT 公网端口 ${conflict.externalPort} 重复（${conflict.usages
          .map((usage) => `${usage.switchLabel} 的 DNAT 规则 ${usage.mappingIndex + 1}`)
          .join('、')}）`,
      );
    });

    const topologySpec = syncTopologySpecFromNodes({
      nodes: normalizedNodes,
    });

    if (!isDraftBlueprintComplete(topologySpec)) {
      validationErrors.push('缺少可作为入口的 ECS 或基础连线未完成');
    }

    if (validationErrors.length > 0) {
      throw new Error(`拓扑检测未通过：${validationErrors.join('；')}`);
    }

    const scenarioTemplateSpec = buildScenarioTemplateSpecFromTopologyGraph({
      topologyGraph,
      metadata: buildScenarioTemplateMetadata(currentTemplate),
      defaults: {
        vpcCidr: topologySpec.vpcCidr,
      },
    });
    const compiledSpec = compileTopologyGraph({
      nodes: normalizedNodes,
    });
    const finalInstanceTypeByHostId = new Map(
      normalizedNodes
        .filter((node): node is EcsTemplateNode => node.kind === 'ecs')
        .map((node) => [node.id, readFinalInstanceType(node)]),
    );

    return {
      topologyGraph,
      topologySpec,
      scenarioTemplateSpec,
      compiledProvisionSpec: compileScenarioTemplateSpec(scenarioTemplateSpec),
      compiledSpec: {
        ...compiledSpec,
        resources: compiledSpec.resources.map((resource) => {
          if (resource.type !== 'host') {
            return resource;
          }

          const instanceType = finalInstanceTypeByHostId.get(resource.id);

          if (!instanceType) {
            return resource;
          }

          return {
            ...resource,
            config: {
              ...resource.config,
              instanceType,
            },
          };
        }),
      },
    };
  }

  useEffect(() => {
    if (providedTemplate) {
      applyTemplateState(providedTemplate);
    }
  }, [providedTemplate, templateId]);

  useEffect(() => {
    if (providedTemplate || !templateId || templateId === 'new' || !session.isReady || !session.token) {
      return;
    }

    let isActive = true;

    fetchRangeTemplateById(apiBaseUrl, session.token, templateId)
      .then((nextTemplate) => {
        if (!isActive) {
          return;
        }

        applyTemplateState(nextTemplate);
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (error instanceof AdminApiError && error.status === 401) {
          session.logout();
          return;
        }

        applyTemplateState(null);
        setStatusMessage(error instanceof Error ? error.message : '编排模板加载失败');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, providedTemplate, session.isReady, session.token, templateId]);

  useEffect(() => {
    if (!session.isReady || !session.token) {
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
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (error instanceof AdminApiError && error.status === 401) {
          session.logout();
          return;
        }

        setStatusMessage(error instanceof Error ? error.message : '平台镜像加载失败');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, session.isReady, session.token]);

  const selectedNode = useMemo(
    () =>
      selection.nodeIds.length === 1 && selection.edgeIds.length === 0
        ? nodes.find((node) => node.id === selection.nodeIds[0]) ?? null
        : null,
    [nodes, selection],
  );
  const selectedEcsNode = useMemo(
    () => (selectedNode?.kind === 'ecs' ? selectedNode : null),
    [selectedNode],
  );
  useEffect(() => {
    if (!selectedEcsNode) {
      setInstanceTypeAvailability(null);
      return;
    }

    if (!session.isReady || !session.token) {
      return;
    }

    const cpu = Number(selectedEcsNode.cpu ?? 0);
    const memory = Number(selectedEcsNode.memory ?? 0);

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
  }, [apiBaseUrl, selectedEcsNode, session.isReady, session.token]);

  useEffect(() => {
    if (!topologyCacheKey || !template) {
      return;
    }

    writeTopologyGraphToCache(
      topologyCacheKey,
      writeTopologyViewport({
        schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes,
        edges,
      } satisfies ScenarioGraphDraft, viewport),
      lastPersistedGraphRef.current,
    );
  }, [edges, nodes, template, topologyCacheKey, viewport]);
  const linkedSwitchIdsByHostId = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nextMap: Record<string, string[]> = {};

    for (const edge of edges) {
      const sourceNode = nodeById.get(edge.fromNodeId);
      const targetNode = nodeById.get(edge.toNodeId);

      if (sourceNode?.kind !== 'switch' || targetNode?.kind !== 'ecs') {
        continue;
      }

      nextMap[targetNode.id] = [...(nextMap[targetNode.id] ?? []), sourceNode.id];
    }

    return nextMap;
  }, [edges, nodes]);

  function commitSnapshot(next: TopologySnapshot, message: string) {
    const nextHistory = pushTopologySnapshot(historyRef.current!, next);
    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setNodes(next.nodes);
    setEdges(next.edges);
    setViewport(next.viewport);
    setStatusMessage(message);
  }

  function restoreHistory(nextHistory: TopologyHistory, message: string) {
    if (nextHistory === historyRef.current) {
      return;
    }

    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setNodes(nextHistory.present.nodes);
    setEdges(nextHistory.present.edges);
    setViewport(nextHistory.present.viewport);
    setSelection({ nodeIds: [], edgeIds: [] });
    setIsPropertyPanelOpen(false);
    setStatusMessage(message);
  }

  function handleSelectionChange(nextSelection: TopologySelection) {
    const nodeIds = [...new Set(nextSelection.nodeIds.filter((nodeId) => nodes.some((node) => node.id === nodeId)))];
    const edgeIds = [...new Set(nextSelection.edgeIds.filter((edgeId) => edges.some((edge) => edge.id === edgeId)))];
    const isSingleNodeSelection = nodeIds.length === 1 && edgeIds.length === 0;

    setSelection({ nodeIds, edgeIds });

    if (isSingleNodeSelection) {
      setIsPropertyPanelOpen(true);
    }

    if (nodeIds.length === 0 && edgeIds.length > 0) {
      setStatusMessage('已选择连线，可执行删除。');
    }
  }

  function handleAddNode(kind: string, position?: { x: number; y: number }) {
    if (isSubmitting || (kind !== 'router' && kind !== 'switch' && kind !== 'ecs')) {
      return;
    }

    const nextIndex = nodes.length + 1;
    const kindCount = nodes.filter((node) => node.kind === kind).length + 1;

    if (kind === 'router' && nodes.some((node) => node.kind === 'router')) {
      setStatusMessage('当前拓扑只允许一个 Router。');
      return;
    }

    const nextNode: TemplateNode =
      kind === 'switch'
        ? createDefaultSwitchNode(
            `${kind}-${nextIndex}`,
            readDefaultNodeLabel('switch', kindCount),
            `zone-${kindCount}`,
            readDefaultSwitchCidr(kindCount),
            kindCount,
          )
        : kind === 'router'
          ? {
              id: `${kind}-${nextIndex}`,
              kind: 'router',
              label: readDefaultNodeLabel('router', kindCount),
              position: createNodePosition('router', kindCount),
              description: '',
              routeRole: 'egress',
              egressType: 'internet',
              bindEip: false,
            }
          : createDefaultEcsNode(
              `ecs-${nextIndex}`,
              readDefaultNodeLabel('ecs', kindCount),
              'core',
              '',
              nextIndex === 1,
              kindCount,
            );
    const nextPosition =
      position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? position
        : nextNode.position;
    const positionedNode = nextPosition ? { ...nextNode, position: nextPosition } : nextNode;

    commitSnapshot(
      { nodes: [...nodes, positionedNode], edges, viewport },
      `已添加${positionedNode.label}，可继续补充属性和关系。`,
    );
    setSelection({ nodeIds: [positionedNode.id], edgeIds: [] });
    setIsPropertyPanelOpen(true);
  }

  function handleUpdateNode(nodeId: string, nextNode: TemplateNode) {
    if (isSubmitting) {
      return;
    }

    const nextNodes = nodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }

      if (node.kind !== 'ecs' || nextNode.kind !== 'ecs') {
        return nextNode;
      }

      const primaryPrivateIp = nextNode.nics?.[0]?.privateIp?.trim() || nextNode.privateIp.trim();
      return {
        ...nextNode,
        privateIp: primaryPrivateIp,
        ...applyEconomyInstanceType(nextNode, {
          preserveExisting: node.cpu === nextNode.cpu && node.memory === nextNode.memory,
        }),
      };
    });

    commitSnapshot({ nodes: nextNodes, edges, viewport }, '已更新节点属性。');
  }

  function handleFlowConnect(connection: { source: string; target: string }) {
    if (isSubmitting) {
      return;
    }

    const sourceNode = nodes.find((node) => node.id === connection.source) ?? null;
    const targetNode = nodes.find((node) => node.id === connection.target) ?? null;

    if (!sourceNode || !targetNode) {
      setStatusMessage('连线节点不存在，请重新选择。');
      return;
    }

    const normalizedPair = normalizeManualEdgePair(sourceNode, targetNode);
    const canonicalSourceNode = normalizedPair?.fromNode ?? sourceNode;
    const canonicalTargetNode = normalizedPair?.toNode ?? targetNode;
    const existingEdge = edges.find(
      (edge) => edge.fromNodeId === canonicalSourceNode.id && edge.toNodeId === canonicalTargetNode.id,
    );

    if (existingEdge) {
      setStatusMessage(`已存在 ${sourceNode.label} -> ${targetNode.label} 的连线。`);
      return;
    }

    const validation = validateManualEdge({ sourceNode, targetNode, edges });

    if (!validation.ok) {
      setStatusMessage(validation.reason);
      return;
    }

    const nextEdge: TemplateEdge = {
      id: `edge-${canonicalSourceNode.id}-${canonicalTargetNode.id}`,
      fromNodeId: canonicalSourceNode.id,
      toNodeId: canonicalTargetNode.id,
      relationType: 'manual',
      label: `${canonicalSourceNode.label} -> ${canonicalTargetNode.label}`,
    };
    const nextNodes =
      canonicalSourceNode.kind === 'switch' && canonicalTargetNode.kind === 'ecs'
        ? nodes.map((node) =>
            node.id === canonicalTargetNode.id && node.kind === 'ecs'
              ? syncHostNicsWithLinkedSwitch(node, canonicalSourceNode)
              : node,
          )
        : nodes;

    commitSnapshot(
      { nodes: nextNodes, edges: [...edges, nextEdge], viewport },
      `已创建连线：${canonicalSourceNode.label} -> ${canonicalTargetNode.label}`,
    );
    setSelection({ nodeIds: [canonicalTargetNode.id], edgeIds: [] });
    setIsPropertyPanelOpen(true);
  }

  function handleDeleteSelection() {
    if (isSubmitting) {
      return;
    }

    const selectedNodeIds = new Set(selection.nodeIds);
    const selectedEdgeIds = new Set(selection.edgeIds);
    const deletedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
    const deletedEdges = edges.filter(
      (edge) =>
        selectedEdgeIds.has(edge.id)
        || selectedNodeIds.has(edge.fromNodeId)
        || selectedNodeIds.has(edge.toNodeId),
    );

    if (deletedNodes.length === 0 && deletedEdges.length === 0) {
      setStatusMessage('请先选择一个节点或连线，再执行删除。');
      return;
    }

    let nextNodes = nodes.filter((node) => !selectedNodeIds.has(node.id));

    for (const deletedNode of deletedNodes) {
      nextNodes = cleanupNodeReferencesAfterDeletion(nextNodes, deletedNode);
    }

    for (const deletedEdge of deletedEdges) {
      nextNodes = cleanupEdgeReferencesAfterDeletion(nextNodes, deletedEdge);
    }

    const nextEdges = edges.filter((edge) => !deletedEdges.includes(edge));
    const message =
      deletedNodes.length === 1 && selection.edgeIds.length === 0
        ? `已删除节点：${deletedNodes[0]!.label}`
        : deletedNodes.length === 0 && deletedEdges.length === 1
          ? '已删除连线'
          : `已删除 ${deletedNodes.length} 个节点和 ${deletedEdges.length} 条连线`;

    commitSnapshot({ nodes: nextNodes, edges: nextEdges, viewport }, message);
    setSelection({ nodeIds: [], edgeIds: [] });
    setIsPropertyPanelOpen(false);
  }

  function handlePositionsCommit(positions: Array<{ id: string; position: { x: number; y: number } }>) {
    if (isSubmitting) {
      return;
    }

    const positionsById = new Map(
      positions
        .filter(({ position }) => Number.isFinite(position.x) && Number.isFinite(position.y))
        .map(({ id, position }) => [id, position]),
    );
    const nextNodes = nodes.map((node) =>
      positionsById.has(node.id)
        ? { ...node, position: positionsById.get(node.id)! }
        : node,
    );

    commitSnapshot({ nodes: nextNodes, edges, viewport }, '已移动选中节点。');
  }

  function handleViewportCommit(nextViewport: TopologyViewport) {
    const validatedViewport = readTopologyViewport(nextViewport);

    if (!validatedViewport) {
      return;
    }

    const currentHistory = historyRef.current!;
    historyRef.current = {
      ...currentHistory,
      present: {
        ...currentHistory.present,
        viewport: validatedViewport,
      },
    };
    setViewport(validatedViewport);
  }

  function handleLayoutAll() {
    if (isSubmitting || nodes.length === 0) {
      return;
    }

    try {
      commitSnapshot({ nodes: layoutTopology(nodes, edges), edges, viewport }, '已完成全部自动布局。');
    } catch {
      setStatusMessage('自动布局失败，请保留当前节点位置。');
    }
  }

  function handleLayoutSelection() {
    if (isSubmitting) {
      return;
    }

    const selectedNodeIds = new Set(selection.nodeIds);
    const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));

    if (selectedNodes.length === 0) {
      setStatusMessage('请先选择需要自动布局的节点。');
      return;
    }

    try {
      const selectedEdges = edges.filter(
        (edge) => selectedNodeIds.has(edge.fromNodeId) && selectedNodeIds.has(edge.toNodeId),
      );
      const laidOutNodesById = new Map(
        layoutTopology(selectedNodes, selectedEdges).map((node) => [node.id, node]),
      );
      const nextNodes = nodes.map((node) => laidOutNodesById.get(node.id) ?? node);

      commitSnapshot({ nodes: nextNodes, edges, viewport }, '已完成选中节点自动布局。');
    } catch {
      setStatusMessage('自动布局失败，请保留当前节点位置。');
    }
  }

  function handleUndo() {
    restoreHistory(undoTopology(historyRef.current!), '已撤销上一步拓扑操作。');
  }

  function handleRedo() {
    restoreHistory(redoTopology(historyRef.current!), '已重做上一步拓扑操作。');
  }

  async function handleDetectTopology() {
    if (!template || !session.token || isSubmitting) {
      return;
    }

    const invalidCustomPasswordMessage = readInvalidCustomPasswordMessage(nodes);

    if (invalidCustomPasswordMessage) {
      setStatusMessage(invalidCustomPasswordMessage);
      return;
    }

    let payload: ReturnType<typeof buildValidatedDraftPayload>;

    try {
      payload = buildValidatedDraftPayload(template, nodes, edges, viewport);
    } catch (error) {
      setStatusMessage(readPersistTopologyErrorMessage(error));
      return;
    }

    setIsSubmitting(true);

    try {
      const previousCacheKey = topologyCacheKey;
      const nextTemplate =
        template.id === 'new'
          ? await createRangeTemplate(apiBaseUrl, session.token, {
              name: template.name?.trim() || '未命名拓扑',
              description: template.description?.trim() || undefined,
              ...payload,
            })
          : await validateAndSaveRangeTemplate(apiBaseUrl, session.token, template.id, {
              ...payload,
              expectedRevision: template.revision,
            });
      const nextCacheKey = readTopologyCacheKey(nextTemplate, nextTemplate.id);

      if (previousCacheKey && previousCacheKey !== nextCacheKey) {
        removeTopologyGraphCache(previousCacheKey);
      }

      if (template.id === 'new' && typeof window !== 'undefined') {
        window.sessionStorage.removeItem(NEW_TEMPLATE_SESSION_KEY);
      }

      applyTemplateState(nextTemplate);
      setStatusMessage('拓扑检测通过，已保存');

      if (template.id === 'new') {
        router.replace(`/admin/scenarios/${nextTemplate.id}`);
      }
    } catch (error) {
      setStatusMessage(readPersistTopologyErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePublishTemplate() {
    if (!template || !session.token || isSubmitting) {
      return;
    }

    const invalidCustomPasswordMessage = readInvalidCustomPasswordMessage(nodes);

    if (invalidCustomPasswordMessage) {
      setStatusMessage(invalidCustomPasswordMessage);
      return;
    }

    if (template.id === 'new' || graphSignature !== lastPersistedGraphRef.current) {
      setStatusMessage('请先点击“检测与保存”，再发布到平台。');
      return;
    }

    if (template.status === 'published') {
      setStatusMessage('当前拓扑已发布到平台。');
      return;
    }

    setIsSubmitting(true);

    try {
      const previousCacheKey = topologyCacheKey;
      const nextTemplate = await shareRangeTemplate(apiBaseUrl, session.token, template.id, {
        expectedRevision: template.revision,
      });
      const nextCacheKey = readTopologyCacheKey(nextTemplate, nextTemplate.id);

      if (previousCacheKey && previousCacheKey !== nextCacheKey) {
        removeTopologyGraphCache(previousCacheKey);
      }

      applyTemplateState(nextTemplate);
      setStatusMessage('拓扑已发布到平台。');
    } catch (error) {
      setStatusMessage(readPublishErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!template && session.isReady && !session.token) {
    return (
      <section className="admin-panel admin-login-panel">
        <h2>请先登录管理员后台</h2>
        <p className="admin-empty">当前没有有效会话，无法打开靶场编排页。</p>
        <Link href="/admin/login">返回登录页</Link>
      </section>
    );
  }

  if (!template) {
    return <TemplateEditorLoadingState />;
  }

  return (
    <section className="template-editor-screen">
      <div className="template-editor-toolbar admin-workbench-surface">
        <div className="template-editor-toolbar-copy">
          <h1>{template.name ?? template.slug}</h1>
          <Badge className="template-editor-toolbar-status" variant={template.status === 'published' ? 'default' : 'outline'}>
            {template.status === 'published' ? '已发布' : '私有'}
          </Badge>
        </div>
        <div className="template-editor-toolbar-actions">
          <Button
            className="border border-destructive/40 bg-card hover:bg-destructive/10 hover:text-destructive"
            disabled={(selection.nodeIds.length === 0 && selection.edgeIds.length === 0) || isSubmitting}
            onClick={handleDeleteSelection}
            size="sm"
            type="button"
            variant="destructive"
          >
            删除选中
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => void handleDetectTopology()}
            size="sm"
            type="button"
            variant="outline"
          >
            检测与保存
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => void handlePublishTemplate()}
            size="sm"
            type="button"
          >
            发布到平台
          </Button>
        </div>
      </div>

      <div className="template-editor-grid">
        <TopologyFlowCanvas
          nodes={nodes}
          edges={edges}
          viewport={viewport}
          onAddNode={handleAddNode}
          onConnect={handleFlowConnect}
          onDeleteSelection={handleDeleteSelection}
          onLayoutAll={handleLayoutAll}
          onLayoutSelection={handleLayoutSelection}
          onPositionsCommit={handlePositionsCommit}
          onRedo={handleRedo}
          onSelectionChange={handleSelectionChange}
          onUndo={handleUndo}
          onViewportCommit={handleViewportCommit}
        />
        {selectedNode && isPropertyPanelOpen ? (
          <TemplatePropertyPanel
            selectedNode={selectedNode}
            allNodes={nodes}
            platformImageAssets={platformImageAssets}
            instanceTypeAvailability={selectedEcsNode ? instanceTypeAvailability : null}
            linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
            onUpdateNode={handleUpdateNode}
            onClose={() => setIsPropertyPanelOpen(false)}
          />
        ) : null}
      </div>
      {statusMessage ? <p aria-live="polite" role="status">{statusMessage}</p> : null}
    </section>
  );
}
