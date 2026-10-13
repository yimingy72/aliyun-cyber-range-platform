'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  nextAvailableGraphId,
  defaultSwitchCidr as readDefaultSwitchCidr,
  type TemplateAuthoringMetadata,
  validateAliyunEcsPassword,
} from '@aliyun-cyber-range/scenario-runtime';

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
import { useAdminScreenCache } from '../../../lib/admin-screen-cache';
import { tencentImageError, verifiedTencentInstanceTypes } from '@/lib/cloud-execution-policy';
import { readCloudWorkspaceSelection, workspaceStorageKey } from '../../../lib/cloud-workspace-selection';
import { useCloudWorkspace } from '../cloud-workspace-provider';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset, RangeTemplate } from '../../../lib/admin-types';
import { resolvePreferredInstanceTypes } from '../../../lib/instance-type-catalog';
import {
  findDuplicateDnatExternalPorts,
  isPhaseOneNodeKind as isPhaseOneNodeKindTypeGuard,
} from '../../../lib/scenario-graph';
import { nextAvailableSwitchCidr, normalizeManualEdgePair, reconcileHostNicConnections, validateManualEdge } from '../../../lib/scenario-graph-linking';
import { hostDnsErrors, readHostDns } from '../../../lib/host-dns';
import type {
  EcsTemplateNode,
  ScenarioGraphDraft,
  ScenarioGraphEdge,
  SwitchTemplateNode,
  TemplateNode,
  TemplateNodeImageStrategy,
} from '../../../lib/scenario-graph';
import { buildTopologyDraftPayload } from '../../../lib/topology-draft-payload';
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
const TOPOLOGY_CACHE_PREFIX = 'template-editor:topology-cache';
const NEW_TEMPLATE_SESSION_KEY = 'template-editor:new-template';
const TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-enterprise-range';

type TopologyCachePayload = {
  topologyGraph: DraftTopologyGraph;
  persistedGraphSignature: string;
};

type NewTemplateSession = {
  draftId?: unknown;
  name?: unknown;
  description?: unknown;
};

type NewTemplateDraft = RangeTemplate & {
  draftId: string;
};

function hasSameTopologySelection(left: TopologySelection, right: TopologySelection) {
  if (left.nodeIds.length !== right.nodeIds.length || left.edgeIds.length !== right.edgeIds.length) {
    return false;
  }

  const leftNodeIds = new Set(left.nodeIds);
  const leftEdgeIds = new Set(left.edgeIds);

  return right.nodeIds.every((nodeId) => leftNodeIds.has(nodeId))
    && right.edgeIds.every((edgeId) => leftEdgeIds.has(edgeId));
}

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

const TemplatePropertyPanel = dynamic(
  () => import('./template-property-panel').then(({ TemplatePropertyPanel: Component }) => Component),
  {
    ssr: false,
    loading: TemplatePropertyPanelPlaceholder,
  },
);

function applyEconomyInstanceType(
  node: Pick<EcsTemplateNode, 'cpu' | 'memory' | 'instanceType' | 'instanceTypeStrategy'>,
  options?: { preserveExisting?: boolean; provider?: 'alibaba_cloud' | 'tencent_cloud' },
): Pick<EcsTemplateNode, 'instanceType' | 'instanceTypeStrategy'> {
  if (options?.provider === 'tencent_cloud') {
    const configured = readConfiguredInstanceType(node.instanceTypeStrategy.instanceType) ?? readConfiguredInstanceType(node.instanceType);
    return options.preserveExisting && configured && !configured.startsWith('ecs.')
      ? { instanceType: configured, instanceTypeStrategy: { mode: 'fixed', instanceType: configured } }
      : { instanceType: undefined, instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] } };
  }
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

function readTopologyCacheKey(template: RangeTemplate | null | undefined, fallbackTemplateId?: string) {
  const draftId =
    template?.id === 'new' && typeof (template as Partial<NewTemplateDraft>).draftId === 'string'
      ? (template as NewTemplateDraft).draftId
      : null;
  const resolvedTemplateId = draftId
    ? `new:${draftId}`
    : template?.id ?? fallbackTemplateId ?? null;
  const revision = template?.revision ?? null;

  if (!resolvedTemplateId || revision === null) {
    return null;
  }

  return workspaceStorageKey(`${TOPOLOGY_CACHE_PREFIX}:${resolvedTemplateId}:${revision}`);
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

function readPersistedTopologyGraphSignature(template: RangeTemplate | null) {
  const topologyGraph = readTemplateTopologyGraph(template);

  return readGraphSignature(
    topologyGraph && Array.isArray((topologyGraph as { nodes?: unknown }).nodes)
      ? readNodesFromRawTopologyGraph(topologyGraph)
      : [],
    topologyGraph && Array.isArray((topologyGraph as { edges?: unknown }).edges)
      ? readEdgesFromRawTopologyGraph(topologyGraph)
      : [],
  );
}

function readResolvedTopologyGraph(template: RangeTemplate | null, fallbackTemplateId?: string) {
  const persistedTopologyGraph = readTemplateTopologyGraph(template);
  const currentPersistedGraphSignature = readPersistedTopologyGraphSignature(template);

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
  provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud',
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
    }, { provider }),
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
    return existingNics[0]?.switchId === switchNode.id && hostNode.zoneKey !== switchNode.zoneKey
      ? {
          ...hostNode,
          zoneKey: switchNode.zoneKey,
        }
      : hostNode;
  }

  const emptyNicIndex = existingNics.findIndex((nic) => !nic.switchId);

  if (emptyNicIndex >= 0) {
    return {
      ...hostNode,
      ...(emptyNicIndex === 0 ? { zoneKey: switchNode.zoneKey } : {}),
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
        id: nextAvailableGraphId(`${hostNode.id}-nic`, existingNics.map((nic) => nic.id)),
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

function buildScenarioTemplateMetadata(template: RangeTemplate, provider: 'alibaba_cloud' | 'tencent_cloud'): TemplateAuthoringMetadata {
  return {
    name: template.name ?? template.slug,
    slug: template.slug,
    version: 'v1',
    cloudProvider: template.cloudProvider ?? template.scenarioTemplateSpec?.metadata.cloudProvider ?? provider,
    iacType: template.iacType ?? 'opentofu',
    modulePathOrRef: (template.cloudProvider ?? provider) === 'tencent_cloud' ? 'infra/opentofu/modules/tencentcloud-enterprise-range' : TEMPLATE_MODULE_PATH,
  };
}

function templateProvider(template: RangeTemplate | null | undefined, provider?: 'alibaba_cloud' | 'tencent_cloud'): 'alibaba_cloud' | 'tencent_cloud' {
  return template?.cloudProvider ?? template?.scenarioTemplateSpec?.metadata.cloudProvider ?? provider ?? 'alibaba_cloud';
}

function createNewTemplateDraftId() {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readNewTemplateSession(): NewTemplateDraft {
  let seed: NewTemplateSession = {};

  if (typeof window !== 'undefined') {
    try {
      seed = JSON.parse(window.sessionStorage.getItem(workspaceStorageKey(NEW_TEMPLATE_SESSION_KEY)) ?? '{}') as typeof seed;
    } catch {
      seed = {};
    }
  }

  const draftId =
    typeof seed.draftId === 'string' && seed.draftId.trim().length > 0
      ? seed.draftId
      : createNewTemplateDraftId();

  if (typeof window !== 'undefined' && seed.draftId !== draftId) {
    window.sessionStorage.setItem(
      workspaceStorageKey(NEW_TEMPLATE_SESSION_KEY),
      JSON.stringify({ ...seed, draftId }),
    );
  }

  return {
    draftId,
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

function readNodeWindowsImageHint(node: EcsTemplateNode, platformImageAssets: PlatformImageAsset[]) {
  const asset = platformImageAssets.find((candidate) => candidate.id === node.platformImageAssetId);
  const osHint = `${asset?.osType ?? ''} ${asset?.platform ?? ''}`.trim().toLowerCase();

  if (osHint) {
    return osHint.includes('windows');
  }

  return [node.imageName, node.imageId, node.image]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes('windows'));
}

function readInvalidCustomPasswordMessage(nodes: TemplateNode[], platformImageAssets: PlatformImageAsset[]) {
  for (const node of nodes) {
    if (node.kind !== 'ecs' || typeof node.customPassword !== 'string' || node.customPassword.length === 0) {
      continue;
    }

    const validationResult = validateAliyunEcsPassword(node.customPassword, {
      windows: readNodeWindowsImageHint(node, platformImageAssets),
    });

    if (!validationResult.valid && validationResult.message) {
      return `${node.label} 自定义密码不合法：${validationResult.message}`;
    }
  }

  return null;
}

function readNodesFromTemplate(template: RangeTemplate | null, fallbackTemplateId?: string): TemplateNode[] {
  return readNodesFromTopologyGraph(readResolvedTopologyGraph(template, fallbackTemplateId), template);
}

function readNodesFromTopologyGraph(topologyGraph: Record<string, unknown> | null, template: RangeTemplate | null): TemplateNode[] {
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
        template?.cloudProvider ?? template?.scenarioTemplateSpec?.metadata.cloudProvider ?? 'alibaba_cloud',
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
        dns: readHostDns(candidateRecord.dns),
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
  return readEdgesFromTopologyGraph(readResolvedTopologyGraph(template, fallbackTemplateId));
}

function readEdgesFromTopologyGraph(topologyGraph: Record<string, unknown> | null): TemplateEdge[] {
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
  const workspace = useCloudWorkspace()?.workspace;
  const canEdit = !workspace || (!workspace.isReadOnly && workspace.capabilities.provisioning);
  const router = useRouter();
  const screenCache = useAdminScreenCache();
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [platformImageAssets, setPlatformImageAssets] = useState<PlatformImageAsset[]>([]);
  const [instanceTypeAvailability, setInstanceTypeAvailability] = useState<InstanceTypeAvailabilitySnapshot | null>(
    null,
  );
  const topologyCacheKey = useMemo(() => readTopologyCacheKey(template, templateId), [template, templateId]);
  const graphSignature = useMemo(() => readGraphSignature(nodes, edges), [edges, nodes]);
  const savedGraphSignature = useMemo(() => {
    // Compare editor shapes, without treating a restored local draft as saved.
    const savedGraph = readTemplateTopologyGraph(template);
    return readGraphSignature(readNodesFromTopologyGraph(savedGraph, template), readEdgesFromTopologyGraph(savedGraph));
  }, [template]);
  const lastPersistedGraphRef = useRef('');

  if (!lastPersistedGraphRef.current) {
    lastPersistedGraphRef.current = readPersistedTopologyGraphSignature(template);
  }
  const instanceTypeAvailabilityRequestRef = useRef(0);
  const historyRef = useRef<TopologyHistory | null>(null);

  if (!historyRef.current) {
    historyRef.current = createTopologyHistory({ nodes, edges, viewport });
  }

  const [, setHistoryState] = useState<TopologyHistory>(historyRef.current);

  function currentProvider() { return templateProvider(template ?? providedTemplate, workspace?.provider); }

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
    lastPersistedGraphRef.current = readPersistedTopologyGraphSignature(nextTemplate);
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
    const switchById = new Map(
      currentNodes
        .filter((node): node is SwitchTemplateNode => node.kind === 'switch')
        .map((node) => [node.id, node]),
    );

    return currentNodes.map((node) =>
      node.kind === 'ecs'
        ? {
            ...node,
            ...(node.nics?.[0]?.switchId && switchById.has(node.nics[0].switchId)
              ? { zoneKey: switchById.get(node.nics[0].switchId)!.zoneKey }
              : {}),
            ...(currentProvider() === 'tencent_cloud' ? {} : applyEconomyInstanceType(node, { preserveExisting: true })),
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
      hostDnsErrors(hostNode).forEach((error) => validationErrors.push(`${hostNode.label}：${error}`));
      const imageOs = platformImageAssets.find((asset) => asset.id === hostNode.platformImageAssetId)?.osType?.toLowerCase();
      if (hostNode.dns && imageOs && imageOs !== 'windows') validationErrors.push(`${hostNode.label} 自定义 DNS 需要 Windows 镜像`);
      if (typeof hostNode.customPassword === 'string' && hostNode.customPassword.length > 0) {
        const passwordValidationResult = validateAliyunEcsPassword(hostNode.customPassword, {
          windows: readNodeWindowsImageHint(hostNode, platformImageAssets),
        });

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

    for (const switchNode of switchNodes) {
      for (const mapping of switchNode.nat?.dnatMappings ?? []) {
        const targetHost = hostNodes.find((hostNode) => hostNode.id === mapping.targetHostId);
        if (!targetHost) {
          validationErrors.push(`DNAT 目标 ECS 不存在：${mapping.targetHostId}`);
        } else if (!(targetHost.nics ?? []).some((nic) => nic.switchId === switchNode.id)) {
          validationErrors.push(`DNAT 目标 ECS 未连接到交换机：${mapping.key}`);
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`拓扑检测未通过：${validationErrors.join('；')}`);
    }

    return buildTopologyDraftPayload({
      graph: topologyGraph,
      metadata: buildScenarioTemplateMetadata(currentTemplate, currentProvider()),
      viewport: currentViewport,
    });
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
    setLoadError(null);

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
        setLoadError(error instanceof Error ? error.message : '编排模板加载失败');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, providedTemplate, session.isReady, session.token, templateId, loadAttempt]);

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
  }, [apiBaseUrl, session.isReady, session.token, workspace?.id]);

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
  }, [apiBaseUrl, selectedEcsNode, session.isReady, session.token, workspace?.id]);

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
    const nextSelectionState = { nodeIds, edgeIds };
    const selectionChanged = !hasSameTopologySelection(selection, nextSelectionState);
    const isSingleNodeSelection = nodeIds.length === 1 && edgeIds.length === 0;

    setSelection((current) => {
      return hasSameTopologySelection(current, nextSelectionState) ? current : nextSelectionState;
    });

    if (isSingleNodeSelection && selectionChanged) {
      setIsPropertyPanelOpen(true);
    }

    if (nodeIds.length === 0 && edgeIds.length > 0) {
      setStatusMessage('已选择连线，可执行删除。');
    }
  }

  function handleFlowNodeActivate(nodeId: string) {
    if (!nodes.some((node) => node.id === nodeId)) {
      return;
    }

    const nextSelection = { nodeIds: [nodeId], edgeIds: [] };
    setSelection((current) => (
      hasSameTopologySelection(current, nextSelection) ? current : nextSelection
    ));
    setIsPropertyPanelOpen(true);
  }

  function handleAddNode(kind: string, position?: { x: number; y: number }) {
    if (isSubmitting || (kind !== 'router' && kind !== 'switch' && kind !== 'ecs')) {
      return;
    }

    const nextNodeId = nextAvailableGraphId(kind, nodes.map((node) => node.id));
    let kindCount = nodes.filter((node) => node.kind === kind).length + 1;
    while (kind !== 'router' && nodes.some((node) => node.kind === kind && node.label === readDefaultNodeLabel(kind, kindCount))) kindCount += 1;
    const switches = nodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch');
    let switchCidr = '';
    if (kind === 'switch') {
      try {
        switchCidr = nextAvailableSwitchCidr(nodes);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : '没有可用的交换机网段');
        return;
      }
    }

    if (kind === 'router' && nodes.some((node) => node.kind === 'router')) {
      setStatusMessage('当前拓扑只允许一个 Router。');
      return;
    }

    const nextNode: TemplateNode =
      kind === 'switch'
        ? createDefaultSwitchNode(
            nextNodeId,
            readDefaultNodeLabel('switch', kindCount),
            nextAvailableGraphId('zone', switches.map((node) => node.zoneKey)),
            switchCidr,
            kindCount,
          )
        : kind === 'router'
          ? {
              id: nextNodeId,
              kind: 'router',
              label: readDefaultNodeLabel('router', kindCount),
              position: createNodePosition('router', kindCount),
              description: '',
              routeRole: 'egress',
              egressType: 'internet',
              bindEip: false,
            }
          : createDefaultEcsNode(
              nextNodeId,
              readDefaultNodeLabel('ecs', kindCount),
              'core',
              '',
              false,
              kindCount,
              currentProvider(),
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
      const primarySwitch = nodes.find((candidate) => candidate.id === nextNode.nics?.[0]?.switchId && candidate.kind === 'switch');
      return {
        ...nextNode,
        zoneKey: primarySwitch?.kind === 'switch' ? primarySwitch.zoneKey : nextNode.zoneKey,
        privateIp: primaryPrivateIp,
        ...applyEconomyInstanceType(nextNode, {
          preserveExisting: node.cpu === nextNode.cpu && node.memory === nextNode.memory, provider: currentProvider(),
        }),
      };
    });

    const next = reconcileHostNicConnections(nodes, nextNodes, edges, nodeId);
    commitSnapshot({ ...next, viewport }, '已更新节点属性。');
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
      commitSnapshot({ nodes: layoutTopology(nodes, edges), edges, viewport }, '');
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
    if (!canEdit || !template || !session.token || isSubmitting) {
      return;
    }

    const invalidCustomPasswordMessage = readInvalidCustomPasswordMessage(nodes, platformImageAssets);

    if (invalidCustomPasswordMessage) {
      setStatusMessage(invalidCustomPasswordMessage);
      return;
    }

    let payload: ReturnType<typeof buildValidatedDraftPayload>;
    setIsSubmitting(true);
    const sourceWorkspaceId = workspace?.id;
    try {
      let validatedNodes = nodes;
      if (currentProvider() === 'tencent_cloud') {
        validatedNodes = await Promise.all(nodes.map(async node => {
          if (node.kind !== 'ecs') return node;
          const image = platformImageAssets.find(asset => asset.id === node.platformImageAssetId && asset.imageId === node.imageId);
          if (!image) throw new Error(`${node.label} 请选择当前工作空间的可用镜像。`);
          const imageError = tencentImageError(image);
          if (imageError) throw new Error(`${node.label} ${imageError}`);
          const cpu = Number(node.cpu);
          const memory = Number(node.memory);
          if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) throw new Error(`${node.label} 请填写有效的 CPU 和内存规格。`);
          const snapshot = await fetchInstanceTypeAvailability(apiBaseUrl, session.token!, cpu, memory);
          const instanceTypes = verifiedTencentInstanceTypes(snapshot, cpu, memory);
          return { ...node, instanceType: instanceTypes[0], instanceTypeStrategy: { mode: 'prefer-list' as const, preferredInstanceTypes: instanceTypes } };
        }));
      }
      if (sourceWorkspaceId && readCloudWorkspaceSelection() !== sourceWorkspaceId) throw new Error('云账号工作空间已切换，请在当前空间重新检测。');
      payload = buildValidatedDraftPayload(template, validatedNodes, edges, viewport);
    } catch (error) {
      setStatusMessage(readPersistTopologyErrorMessage(error));
      setIsSubmitting(false);
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
        window.sessionStorage.removeItem(workspaceStorageKey(NEW_TEMPLATE_SESSION_KEY));
      }

      applyTemplateState(nextTemplate);
      screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
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
    if (!canEdit || !template || !session.token || isSubmitting) {
      return;
    }

    const invalidCustomPasswordMessage = readInvalidCustomPasswordMessage(nodes, platformImageAssets);

    if (invalidCustomPasswordMessage) {
      setStatusMessage(invalidCustomPasswordMessage);
      return;
    }

    if (template.id === 'new' || graphSignature !== savedGraphSignature) {
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
      screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
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
    if (loadError) {
      return (
        <section className="admin-panel">
          <p role="alert">编排模板加载失败：{loadError}</p>
          <Button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重试加载</Button>
          <Link href="/admin/scenarios">返回靶场编排</Link>
        </section>
      );
    }
    return null;
  }

  return (
    <section className="template-editor-screen">
      <div className="template-editor-toolbar admin-workbench-surface">
        <div className="template-editor-toolbar-copy">
          <div className="template-editor-toolbar-identity">
            <h1>{template.name ?? template.slug}</h1>
            <Badge className="template-editor-toolbar-status" variant={template.status === 'published' ? 'default' : 'outline'}>
              {template.status === 'published' ? '已发布' : '私有'}
            </Badge>
            {statusMessage ? (
              <p
                aria-live="polite"
                className="template-editor-toolbar-secondary template-editor-feedback"
                role="status"
                title={statusMessage}
              >
                {statusMessage}
              </p>
            ) : null}
          </div>
        </div>
        <div className="template-editor-toolbar-actions">
          <Button
            className="border border-destructive/40 bg-card hover:bg-destructive/10 hover:text-destructive"
            disabled={!canEdit || (selection.nodeIds.length === 0 && selection.edgeIds.length === 0) || isSubmitting}
            onClick={handleDeleteSelection}
            size="sm"
            type="button"
            variant="destructive"
          >
            删除选中
          </Button>
          <Button
            disabled={!canEdit || isSubmitting}
            onClick={() => void handleDetectTopology()}
            size="sm"
            type="button"
            variant="outline"
          >
            检测与保存
          </Button>
          <Button
            disabled={!canEdit || isSubmitting}
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
          mode={canEdit ? 'edit' : 'readonly'}
          nodes={nodes}
          edges={edges}
          viewport={viewport}
          onAddNode={handleAddNode}
          onConnect={handleFlowConnect}
          onDeleteSelection={handleDeleteSelection}
          onLayoutAll={handleLayoutAll}
          onNodeActivate={handleFlowNodeActivate}
          onPositionsCommit={handlePositionsCommit}
          onRedo={handleRedo}
          onSelectionChange={handleSelectionChange}
          onUndo={handleUndo}
          onViewportCommit={handleViewportCommit}
          selection={selection}
        />
        {selectedNode && isPropertyPanelOpen ? (
          <TemplatePropertyPanel
            readOnly={!canEdit}
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
    </section>
  );
}
