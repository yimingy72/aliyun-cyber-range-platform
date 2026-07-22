'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { validateAliyunEcsPassword } from '@aliyun-cyber-range/scenario-runtime';

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
import { TemplateCanvas } from './template-canvas';
import { TemplateNodePalette } from './template-node-palette';
import { TemplatePropertyPanel } from './template-property-panel';

type TemplateEditorScreenProps = {
  templateId?: string;
  apiBaseUrl?: string;
  template?: RangeTemplate;
};

type DraftTopologyGraph = ScenarioGraphDraft;
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pendingLinkSourceNodeId, setPendingLinkSourceNodeId] = useState<string | null>(null);
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

  function applyTemplateState(nextTemplate: RangeTemplate | null) {
    const nextNodes = readNodesFromTemplate(nextTemplate, templateId);
    const nextEdges = readEdgesFromTemplate(nextTemplate, templateId);
    setTemplate(nextTemplate);
    setNodes(nextNodes);
    setEdges(nextEdges);
    lastPersistedGraphRef.current = readGraphSignature(nextNodes, nextEdges);
  }

function buildDraftUpdatePayload(
  currentNodes: TemplateNode[],
  currentEdges: TemplateEdge[],
) {
    return {
      topologyGraph: {
        schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes: currentNodes,
        edges: currentEdges,
      } satisfies DraftTopologyGraph,
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
  ) {
    const normalizedNodes = normalizeNodesForValidatedPayload(currentNodes);
    const graphPayload = buildDraftUpdatePayload(normalizedNodes, currentEdges);
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
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
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

    writeTopologyGraphToCache(topologyCacheKey, {
      schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
      nodes,
      edges,
    }, lastPersistedGraphRef.current);
  }, [edges, nodes, template, topologyCacheKey]);
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

  function handleAddNode(kind: string) {
    if (isSubmitting) {
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

    setNodes((previous) => [...previous, nextNode]);
    setSelectedNodeId(nextNode.id);
    setSelectedEdgeId(null);
    setPendingLinkSourceNodeId(null);
    setStatusMessage(`已添加${nextNode.label}，可继续补充属性和关系。`);
  }

  function handleUpdateNode(nodeId: string, nextNode: TemplateNode) {
    if (isSubmitting) {
      return;
    }

    setNodes((previous) =>
      previous.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        if (node.kind !== 'ecs' || nextNode.kind !== 'ecs') {
          return nextNode;
        }

        return {
          ...nextNode,
          ...applyEconomyInstanceType(nextNode, {
            preserveExisting: node.cpu === nextNode.cpu && node.memory === nextNode.memory,
          }),
        };
      }),
    );
  }

  function handleMoveNode(nodeId: string, position: { x: number; y: number }) {
    if (isSubmitting) {
      return;
    }

    setNodes((previous) =>
      previous.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              position,
            }
          : node,
      ),
    );
  }

  function handleOpenNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setPendingLinkSourceNodeId(null);
  }

  function handleBoardClick() {
    if (!pendingLinkSourceNodeId && !statusMessage && !selectedEdgeId) {
      return;
    }

    setPendingLinkSourceNodeId(null);
    setSelectedEdgeId(null);
    setStatusMessage('');
  }

  function handleSelectEdge(edgeId: string) {
    setSelectedNodeId(null);
    setSelectedEdgeId(edgeId);
    setPendingLinkSourceNodeId(null);
    setStatusMessage('已选择连线，可执行删除。');
  }

  function handleSelectNode(nodeId: string) {
    if (isSubmitting) {
      return;
    }

    if (!pendingLinkSourceNodeId) {
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
      setPendingLinkSourceNodeId(nodeId);
      setStatusMessage('已选择连线起点，请点击目标节点完成连接。');
      return;
    }

    if (pendingLinkSourceNodeId === nodeId) {
      setPendingLinkSourceNodeId(null);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
      setStatusMessage('已取消当前连线起点。');
      return;
    }

    const sourceNode = nodes.find((node) => node.id === pendingLinkSourceNodeId) ?? null;
    const targetNode = nodes.find((node) => node.id === nodeId) ?? null;

    if (!sourceNode || !targetNode) {
      setPendingLinkSourceNodeId(null);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
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
      setPendingLinkSourceNodeId(null);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
      setStatusMessage(`已存在 ${sourceNode.label} -> ${targetNode.label} 的连线。`);
      return;
    }

    const validation = validateManualEdge({
      sourceNode,
      targetNode,
      edges,
    });

    if (!validation.ok) {
      setPendingLinkSourceNodeId(null);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
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

    if (canonicalSourceNode.kind === 'switch' && canonicalTargetNode.kind === 'ecs') {
      setNodes((previous) =>
        previous.map((node) =>
          node.id === canonicalTargetNode.id && node.kind === 'ecs'
            ? syncHostNicsWithLinkedSwitch(node, canonicalSourceNode as SwitchTemplateNode)
            : node,
        ),
      );
    }

    setEdges((previous) => [...previous, nextEdge]);
    setPendingLinkSourceNodeId(null);
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setStatusMessage(`已创建连线：${canonicalSourceNode.label} -> ${canonicalTargetNode.label}`);
  }

  function handleDeleteSelectedNode() {
    if (isSubmitting) {
      return;
    }

    if (selectedEdgeId) {
      const targetEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;

      if (!targetEdge) {
        setSelectedEdgeId(null);
        setStatusMessage('当前选中的连线不存在。');
        return;
      }

      setNodes((previous) => cleanupEdgeReferencesAfterDeletion(previous, targetEdge));
      setEdges((previous) => previous.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      setPendingLinkSourceNodeId(null);
      setStatusMessage('已删除连线');
      return;
    }

    if (!selectedNodeId) {
      setStatusMessage('请先选择一个节点或连线，再执行删除。');
      return;
    }

    const targetNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

    if (!targetNode) {
      setStatusMessage('当前选中的节点不存在。');
      return;
    }

    setNodes((previous) =>
      cleanupNodeReferencesAfterDeletion(
        previous.filter((node) => node.id !== selectedNodeId),
        targetNode,
      ),
    );
    setEdges((previous) => previous.filter((edge) => edge.fromNodeId !== selectedNodeId && edge.toNodeId !== selectedNodeId));
    setPendingLinkSourceNodeId((previous) => (previous === selectedNodeId ? null : previous));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setStatusMessage(`已删除节点：${targetNode.label}`);
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
      payload = buildValidatedDraftPayload(template, nodes, edges);
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
      setPendingLinkSourceNodeId(null);
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
      setStatusMessage('请先点击“检测&保存”，再发布到平台。');
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
      setPendingLinkSourceNodeId(null);
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

  const topologyGraph = {
    ...(template?.topologyGraph ?? {}),
    schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
    nodes,
    edges,
  };

  if (!template) {
    return (
      <section className="admin-panel">
        <h2>正在加载靶场编排页...</h2>
        <p className="admin-empty">请稍候，正在读取当前拓扑。</p>
      </section>
    );
  }

  return (
    <section className="template-editor-screen">
      <div className="template-editor-toolbar admin-panel">
        <div className="template-editor-toolbar-copy">
          <h1>{template.name ?? template.slug}</h1>
          <p className="template-editor-toolbar-status">
            {template.status === 'published' ? '已发布' : '私有'}
          </p>
        </div>
        <div className="admin-inline-actions">
          <button
            type="button"
            className="template-editor-toolbar-button is-danger"
            disabled={(!selectedNodeId && !selectedEdgeId) || isSubmitting}
            onClick={handleDeleteSelectedNode}
          >
            删除选中
          </button>
          <button
            type="button"
            className="template-editor-toolbar-button is-neutral"
            disabled={isSubmitting}
            onClick={() => void handleDetectTopology()}
          >
            检测&保存
          </button>
          <button
            type="button"
            className="template-editor-toolbar-button is-primary"
            disabled={isSubmitting}
            onClick={() => void handlePublishTemplate()}
          >
            发布到平台
          </button>
        </div>
      </div>

      <div className="template-editor-grid">
        <TemplateNodePalette onAddNode={handleAddNode} />
        <TemplateCanvas
          topologyGraph={topologyGraph}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          pendingLinkSourceNodeId={pendingLinkSourceNodeId}
          statusMessage={statusMessage}
          onSelectNode={handleSelectNode}
          onSelectEdge={handleSelectEdge}
          onOpenNode={handleOpenNode}
          onMoveNode={handleMoveNode}
          onBoardClick={handleBoardClick}
        />
        <TemplatePropertyPanel
          selectedNode={selectedNode}
          allNodes={nodes}
          platformImageAssets={platformImageAssets}
          instanceTypeAvailability={selectedEcsNode ? instanceTypeAvailability : null}
          linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
          onUpdateNode={handleUpdateNode}
        />
      </div>
    </section>
  );
}
