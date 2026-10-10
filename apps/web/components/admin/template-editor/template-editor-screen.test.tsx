// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeAdminSession } from '../../../lib/admin-auth-storage';
import { setCloudWorkspaceSelection, workspaceStorageKey } from '../../../lib/cloud-workspace-selection';
import type { TopologyFlowCanvas } from './topology-flow-canvas';

const workspaceState = vi.hoisted(() => ({ value: null as any }));
vi.mock('../cloud-workspace-provider', () => ({ useCloudWorkspace: () => workspaceState.value }));

type TopologyFlowCanvasMockProps = React.ComponentProps<typeof TopologyFlowCanvas>;

function TopologyFlowCanvasMock({
  edges,
  nodes,
  onAddNode,
  onConnect,
  onDeleteSelection,
  onLayoutAll,
  onNodeActivate,
  onPositionsCommit,
  onRedo,
  onSelectionChange,
  onUndo,
  onViewportCommit,
  viewport,
}: TopologyFlowCanvasMockProps) {
  const [pendingNodeId, setPendingNodeId] = React.useState<string | null>(null);
  const [shouldReplaySelection, setShouldReplaySelection] = React.useState(false);

  React.useEffect(() => {
    if (shouldReplaySelection && nodes.length > 0) {
      onSelectionChange({ nodeIds: [nodes[0]!.id], edgeIds: [] });
    }
  }, [nodes, onSelectionChange, shouldReplaySelection]);

  function selectNode(nodeId: string) {
    if (pendingNodeId) {
      onConnect({ source: pendingNodeId, target: nodeId });
      setPendingNodeId(null);
    } else {
      setPendingNodeId(nodeId);
    }

    onSelectionChange({ nodeIds: [nodeId], edgeIds: [] });
    onNodeActivate(nodeId);
  }

  function readNodeAccessibleName(node: (typeof nodes)[number]) {
    if (node.kind === 'router') {
      return `${node.label} VPC 根节点`;
    }

    if (node.kind === 'switch') {
      return `${node.label} ${node.cidr}`;
    }

    return `${node.label} ${node.privateIp || node.nics?.[0]?.privateIp || node.networkInterfaces[0]?.privateIp || ''}`;
  }

  return (
    <section data-testid="topology-flow-canvas" data-viewport={JSON.stringify(viewport)}>
      <button onClick={() => onAddNode('router')} type="button">路由器 router</button>
      <button onClick={() => onAddNode('switch')} type="button">交换机 switch</button>
      <button onClick={() => onAddNode('ecs')} type="button">虚拟主机 virtual client</button>
      <button
        onClick={() => {
          const source = nodes.find((node) => node.kind === 'switch');
          const target = nodes.find((node) => node.kind === 'ecs');

          if (source && target) {
            onConnect({ source: source.id, target: target.id });
          }
        }}
        type="button"
      >
        flow connect valid
      </button>
      <button
        onClick={() => {
          const source = nodes.find((node) => node.kind === 'router');
          const target = nodes.find((node) => node.kind === 'switch');

          if (source && target) {
            onConnect({ source: source.id, target: target.id });
          }
        }}
        type="button"
      >
        flow connect router switch
      </button>
      <button
        onClick={() => {
          const node = nodes.find((candidate) => candidate.kind === 'ecs');

          if (node) {
            onConnect({ source: node.id, target: node.id });
          }
        }}
        type="button"
      >
        flow connect invalid
      </button>
      <button onClick={onDeleteSelection} type="button">flow delete selection</button>
      <button
        onClick={() =>
          onPositionsCommit(nodes.map((node, index) => ({
            id: node.id,
            position: { x: 180 + index * 120, y: 220 + index * 80 },
          })))
        }
        type="button"
      >
        flow commit positions
      </button>
      <button onClick={() => onViewportCommit({ x: -80, y: 40, zoom: 1.2 })} type="button">
        flow commit viewport
      </button>
      <button onClick={onLayoutAll} type="button">flow layout all</button>
      <button onClick={onUndo} type="button">flow undo</button>
      <button onClick={onRedo} type="button">flow redo</button>
      <button
        onClick={() => {
          setPendingNodeId(null);
          onSelectionChange({ nodeIds: [], edgeIds: [] });
        }}
        type="button"
      >
        flow clear selection
      </button>
      <button
        onClick={() => onSelectionChange({ nodeIds: nodes.slice(0, 2).map((node) => node.id), edgeIds: [] })}
        type="button"
      >
        flow select multiple nodes
      </button>
      <button onClick={() => setShouldReplaySelection(true)} type="button">
        flow replay selection
      </button>
      {nodes.map((node) => (
        <button
          aria-label={readNodeAccessibleName(node)}
          data-world-x={node.position?.x}
          data-world-y={node.position?.y}
          key={node.id}
          onClick={() => selectNode(node.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setPendingNodeId(null);
            onSelectionChange({ nodeIds: [node.id], edgeIds: [] });
          }}
          style={node.position ? { left: node.position.x, top: node.position.y } : undefined}
          type="button"
        >
          {readNodeAccessibleName(node)}
        </button>
      ))}
      {edges.map((edge) => (
        <button
          aria-label={`选择连线 ${edge.id}`}
          data-testid={`topology-flow-edge-${edge.id}`}
          key={edge.id}
          onClick={() => onSelectionChange({ nodeIds: [], edgeIds: [edge.id] })}
          type="button"
        >
          {edge.label ?? `${edge.fromNodeId} -> ${edge.toNodeId}`}
        </button>
      ))}
    </section>
  );
}

const {
  fetchRangeTemplatesMock,
  fetchRangeTemplateByIdMock,
  createRangeTemplateMock,
  validateAndSaveRangeTemplateMock,
  shareRangeTemplateMock,
  fetchPlatformImagesMock,
  fetchPublicImageCatalogScopeMock,
  fetchCustomImageCatalogScopeMock,
  fetchInstanceTypeAvailabilityMock,
  replaceMock,
} = vi.hoisted(() => ({
  fetchRangeTemplatesMock: vi.fn(),
  fetchRangeTemplateByIdMock: vi.fn(),
  createRangeTemplateMock: vi.fn(),
  validateAndSaveRangeTemplateMock: vi.fn(),
  shareRangeTemplateMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchInstanceTypeAvailabilityMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    fetchRangeTemplates: fetchRangeTemplatesMock,
    fetchRangeTemplateById: fetchRangeTemplateByIdMock,
    createRangeTemplate: createRangeTemplateMock,
    validateAndSaveRangeTemplate: validateAndSaveRangeTemplateMock,
    shareRangeTemplate: shareRangeTemplateMock,
    fetchPlatformImages: fetchPlatformImagesMock,
    fetchPublicImageCatalogScope: fetchPublicImageCatalogScopeMock,
    fetchCustomImageCatalogScope: fetchCustomImageCatalogScopeMock,
    fetchInstanceTypeAvailability: fetchInstanceTypeAvailabilityMock,
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));
vi.mock('./topology-flow-canvas', () => ({
  TopologyFlowCanvas: TopologyFlowCanvasMock,
}));
import { AdminApiError } from '../../../lib/admin-api';
import type { TemplateNode } from '../../../lib/scenario-graph';
import { buildScenarioTemplateSpecFromTopologyGraph } from '../../../lib/topology-graph-to-scenario-template';
import { TemplateEditorScreen as ActualTemplateEditorScreen } from './template-editor-screen';
import { TemplatePropertyPanel } from './template-property-panel';

function normalizeTemplateFixture(template: React.ComponentProps<typeof ActualTemplateEditorScreen>['template']) {
  const legacyTemplate = template as
    | (React.ComponentProps<typeof ActualTemplateEditorScreen>['template'] & {
        currentDraftVersion?: { topologyGraph?: Record<string, unknown> | null } | null;
        currentPublishedVersion?: unknown;
      })
    | undefined;

  return legacyTemplate
    ? ({
        ...legacyTemplate,
        status: legacyTemplate.status ?? (legacyTemplate.currentPublishedVersion ? 'published' : 'private'),
        revision: legacyTemplate.revision ?? 1,
        topologyGraph: legacyTemplate.topologyGraph ?? legacyTemplate.currentDraftVersion?.topologyGraph ?? null,
      } as React.ComponentProps<typeof ActualTemplateEditorScreen>['template'])
    : undefined;
}

function TemplateEditorScreen(props: React.ComponentProps<typeof ActualTemplateEditorScreen>) {
  return <ActualTemplateEditorScreen {...props} template={normalizeTemplateFixture(props.template)} />;
}

function selectAdminOption(controlName: string, optionName: string) {
  fireEvent.click(screen.getByRole('combobox', { name: controlName }));
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

function addDnatEntry(targetHostName = 'ECS 1', mappingIndex = 1) {
  fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
  fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
  selectAdminOption(`DNAT 目标主机 ${mappingIndex}`, targetHostName);
}

function addRouterConnection() {
  fireEvent.click(screen.getByRole('button', { name: '路由器 router' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow connect router switch' }));
}

vi.mock('../use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    logout: () => undefined,
  }),
}));

function buildUpdatedTemplateResponse(
  payload: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'template-1',
    name: '企业攻防靶场',
    slug: 'enterprise-range',
    version: 'v1.1.0',
    visibility: 'private',
    status: 'private',
    revision: 4,
    topologyGraph: (payload?.topologyGraph as Record<string, unknown> | undefined) ?? {
      schemaVersion: '2.0.0',
      nodes: [],
      edges: [],
    },
    ...(payload?.topologySpec ? { topologySpec: payload.topologySpec } : {}),
    ...(payload?.scenarioTemplateSpec ? { scenarioTemplateSpec: payload.scenarioTemplateSpec } : {}),
    ...(payload?.compiledProvisionSpec ? { compiledProvisionSpec: payload.compiledProvisionSpec } : {}),
    ...(payload?.compiledSpec ? { compiledSpec: payload.compiledSpec } : {}),
    currentDraftVersionId: 'draft-2',
    currentPublishedVersionId: null,
    currentDraftVersion: {
      id: 'draft-2',
      status: 'draft',
      version: 'v1.1.0',
      topologyGraph: (payload?.topologyGraph as Record<string, unknown> | undefined) ?? {
        schemaVersion: '2.0.0',
        nodes: [],
        edges: [],
      },
      ...(payload?.topologySpec ? { topologySpec: payload.topologySpec } : {}),
      ...(payload?.scenarioTemplateSpec ? { scenarioTemplateSpec: payload.scenarioTemplateSpec } : {}),
      ...(payload?.compiledProvisionSpec ? { compiledProvisionSpec: payload.compiledProvisionSpec } : {}),
      ...(payload?.compiledSpec ? { compiledSpec: payload.compiledSpec } : {}),
    },
    currentPublishedVersion: null,
    ...overrides,
  };
}

beforeEach(() => {
  workspaceState.value = null;
  setCloudWorkspaceSelection('template-author-fixture', null);
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
  fetchRangeTemplatesMock.mockResolvedValue([]);
  fetchRangeTemplateByIdMock.mockResolvedValue(null);
  validateAndSaveRangeTemplateMock.mockImplementation(
    async (_apiBaseUrl: string, _token: string, _id: string, payload: Record<string, unknown>) =>
      buildUpdatedTemplateResponse(payload),
  );
  fetchPlatformImagesMock.mockResolvedValue({
    items: [
      {
        id: 'platform-image-1',
        displayName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        provider: 'alibaba_cloud',
        accountUid: null,
        accountScopeKey: 'public:cn-hangzhou',
        regionId: 'cn-hangzhou',
        sourceScope: 'public',
        sourceSnapshotId: 'snapshot-public-1',
        enabled: true,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
  });
  fetchPublicImageCatalogScopeMock.mockResolvedValue({
    snapshots: [],
    catalogItems: [
      {
        id: 'catalog-image-public-1',
        displayName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        provider: 'alibaba_cloud',
        scope: 'public',
        accountUid: null,
        regionId: 'cn-hangzhou',
        enabled: true,
        sourceSnapshotId: 'snapshot-public-1',
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
  });
  fetchCustomImageCatalogScopeMock.mockResolvedValue({
    snapshots: [],
    catalogItems: [],
  });
  fetchInstanceTypeAvailabilityMock.mockResolvedValue({
    cpu: 1,
    memory: 2,
    regionId: 'cn-hangzhou',
    zoneId: 'cn-hangzhou-h',
    exactAvailable: true,
    matches: [
      {
        instanceTypeId: 'ecs.c7.large',
        cpu: 1,
        memoryGiB: 2,
        family: 'ecs.c7',
        generation: 'ecs-7',
        architecture: 'X86',
      },
    ],
    warning: null,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear?.();
  fetchRangeTemplatesMock.mockReset();
  fetchRangeTemplateByIdMock.mockReset();
  validateAndSaveRangeTemplateMock.mockReset();
  createRangeTemplateMock.mockReset();
  shareRangeTemplateMock.mockReset();
  replaceMock.mockReset();
  fetchPlatformImagesMock.mockReset();
  fetchPublicImageCatalogScopeMock.mockReset();
  fetchCustomImageCatalogScopeMock.mockReset();
  fetchInstanceTypeAvailabilityMock.mockReset();
});

describe('TemplateEditorScreen', () => {
  it('restores DNS configuration from a saved template and blocks stale NIC targets before API validation', async () => {
    render(<TemplateEditorScreen template={{
      id: 'template-dns', name: '域场景', slug: 'domain-range', revision: 1,
      topologyGraph: { schemaVersion: '2.0.0', nodes: [{
        id: 'member', kind: 'ecs', label: 'Windows 成员', imageId: 'windows-image',
        platformImageAssetId: 'windows-asset', imageName: 'Windows Server',
        privateIp: '10.0.50.20', nics: [{ id: 'member-primary', switchId: '', privateIp: '10.0.50.20', secondaryIps: [], securityGroupRules: [] }],
        dns: { servers: ['10.0.50.10'], nicIds: ['deleted-nic'], domain: 'lab.example' },
      }], edges: [] },
    }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Windows 成员/ }));
    expect((await screen.findByLabelText('DNS 服务器') as HTMLTextAreaElement).value).toBe('10.0.50.10');
    expect((screen.getByLabelText('DNS 验证域名') as HTMLInputElement).value).toBe('lab.example');
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));
    expect(await screen.findByText(/Windows 成员：DNS 作用网卡已不存在，请重新选择/)).toBeTruthy();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
  });
  it('does not render a standalone loading page while loading a routed template', () => {
    fetchRangeTemplateByIdMock.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the route request pending to verify that no loading page is shown.
        }),
    );

    render(<TemplateEditorScreen templateId="template-1" />);

    expect(screen.queryByRole('status', { name: '正在加载靶场编排页' })).toBeNull();
    expect(screen.queryByTestId('template-editor-loading-grid')).toBeNull();
  });

  it('renders the topology-flow editor workspace instead of the retired template canvas', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByText('企业攻防靶场')).toBeTruthy();
    expect(screen.getByTestId('topology-flow-canvas')).toBeTruthy();
    expect(screen.queryByTestId('template-canvas-board')).toBeNull();
    expect(screen.getByText('已发布').getAttribute('data-slot')).toBe('badge');
    expect(screen.getByRole('button', { name: '删除选中' }).getAttribute('data-variant')).toBe('destructive');
    expect(screen.getByRole('button', { name: '检测与保存' }).getAttribute('data-variant')).toBe('outline');
    expect(screen.getByRole('button', { name: '发布到平台' }).getAttribute('data-variant')).toBe('default');
  });

  it('maps an unconnected nic switch option to an empty business value', () => {
    const onUpdateNode = vi.fn();
    const selectedNode = {
      id: 'ecs-1',
      kind: 'ecs',
      label: 'ECS 1',
      zoneKey: 'core',
      role: 'host',
      privateIp: '10.0.0.11',
      exposePublic: false,
      image: 'ubuntu_22_04_x64_20G_alibase',
      dnatMappings: [],
      networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.11' }],
      portGroups: [],
      nics: [
        {
          id: 'ecs-1-nic-1',
          switchId: 'switch-1',
          privateIp: '10.0.0.11',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
    } satisfies TemplateNode;
    const switchNode = {
      id: 'switch-1',
      kind: 'switch',
      label: '交换机 1',
      zoneKey: 'core',
      cidr: '10.0.0.0/24',
      purpose: 'business-zone',
    } satisfies TemplateNode;

    render(
      <TemplatePropertyPanel
        allNodes={[selectedNode, switchNode]}
        onUpdateNode={onUpdateNode}
        selectedNode={selectedNode}
      />,
    );

    selectAdminOption('交换机标识 1', '未连接交换机');

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      'ecs-1',
      expect.objectContaining({
        nics: [expect.objectContaining({ switchId: '' })],
      }),
    );
  });

  it('loads platform image assets and the current user\'s own image assets for ecs image options', async () => {
    fetchPlatformImagesMock.mockImplementation(
      async (_apiBaseUrl: string, _token: string, view?: string) => ({
        items:
          view === 'mine'
            ? [
                {
                  id: 'my-image-1',
                  displayName: '我的渗透靶机',
                  imageId: 'm-bp1c97oenzc22sbr1e7s',
                  provider: 'alibaba_cloud',
                  accountUid: null,
                  accountScopeKey: 'public:cn-hangzhou',
                  regionId: 'cn-hangzhou',
                  sourceScope: 'custom',
                  sourceSnapshotId: 'snapshot-custom-1',
                  enabled: true,
                  createdAt: '2026-07-03T00:00:00.000Z',
                  updatedAt: '2026-07-03T00:00:00.000Z',
                },
              ]
            : [
                {
                  id: 'platform-image-1',
                  displayName: 'Ubuntu 24.04 LTS',
                  imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
                  provider: 'alibaba_cloud',
                  accountUid: null,
                  accountScopeKey: 'public:cn-hangzhou',
                  regionId: 'cn-hangzhou',
                  sourceScope: 'public',
                  sourceSnapshotId: 'snapshot-public-1',
                  enabled: true,
                  createdAt: '2026-07-03T00:00:00.000Z',
                  updatedAt: '2026-07-03T00:00:00.000Z',
                },
              ],
      }),
    );

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'platform');
      expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'mine');
    });
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();
    expect(fetchCustomImageCatalogScopeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const imageCombobox = await screen.findByRole('combobox', { name: '镜像名' });
    expect(imageCombobox).toBeTruthy();
    fireEvent.change(imageCombobox, { target: { value: '我的渗透靶机' } });
    expect(await screen.findByRole('option', { name: '我的渗透靶机' })).toBeTruthy();
  });

  it('starts a new ECS without an image and blocks topology validation until an image is selected', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((await screen.findByRole('combobox', { name: '镜像名' }) as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    expect(await screen.findByText(/ECS 1 请选择镜像/)).toBeTruthy();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('supports only router, switch and ecs nodes in the phase-one topology editor', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: '编辑模式' })).toBeNull();
    expect(screen.queryByRole('button', { name: '连线模式' })).toBeNull();

    expect(screen.queryByText('点击添加')).toBeNull();
    expect(screen.queryByText('点击添加节点，无需拖动。')).toBeNull();
    expect(screen.queryByRole('button', { name: '生成第一阶段骨架' })).toBeNull();
    expect(screen.queryByTestId('template-node-palette-icon-ecs')).toBeNull();
    expect(screen.queryByTestId('template-node-palette-icon-router')).toBeNull();
    expect(screen.queryByTestId('template-node-palette-icon-switch')).toBeNull();
    expect(screen.queryByText('NAT 网关')).toBeNull();
    expect(screen.queryByText('EIP')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Router/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));

    expect(await screen.findByLabelText('交换机名称')).toBeTruthy();
    expect(screen.queryByLabelText('区域标识')).toBeNull();
  });

  it('uses per-kind naming, keeps router singleton, and assigns the new default switch cidr sequence', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /ECS 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Router VPC 根节点/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Router 2/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.queryByText('子网信息配置')).toBeNull();
    expect((await screen.findByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: /交换机 2/ }));
    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('192');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('168');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: /交换机 3/ }));
    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('172');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '32' } });
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('29');

    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '16' } });
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('17');
  });

  it('shows an inline warning when the selected ecs cpu-memory combination has no exact x86 postpaid match', async () => {
    fetchInstanceTypeAvailabilityMock.mockResolvedValueOnce({
      cpu: 2,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: false,
      matches: [],
      warning: '当前默认可用区 cn-hangzhou-h 没有精确匹配 2C2G 的 X86 按量付费实例规格。',
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    await waitFor(() =>
      expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        2,
        2,
      ),
    );

    expect(
      await screen.findByText('当前默认可用区 cn-hangzhou-h 没有精确匹配 2C2G 的 X86 按量付费实例规格。'),
    ).toBeTruthy();
  });

  it('rechecks instance type availability when ecs cpu-memory fields change', async () => {
    fetchInstanceTypeAvailabilityMock
      .mockResolvedValueOnce({
        cpu: 2,
        memory: 2,
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        exactAvailable: true,
        matches: [],
        warning: null,
      })
      .mockResolvedValueOnce({
        cpu: 2,
        memory: 4,
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        exactAvailable: true,
        matches: [
          {
            instanceTypeId: 'ecs.g7.xlarge',
            cpu: 2,
            memoryGiB: 4,
            family: 'ecs.g7',
            generation: 'ecs-7',
            architecture: 'X86',
          },
        ],
        warning: null,
      });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('内存'), {
      target: { value: '4' },
    });

    await waitFor(() =>
      expect(fetchInstanceTypeAvailabilityMock).toHaveBeenNthCalledWith(
        2,
        'http://localhost:3001',
        'dev-admin-token',
        2,
        4,
      ),
    );
  });

  it('creates ecs without default ip and only accepts nic ip values inside the selected switch cidr', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const privateIpInput = screen.getByLabelText('私网 IP 1') as HTMLInputElement;
    expect(privateIpInput.value).toBe('');

    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(privateIpInput, { target: { value: '192.168.1.10' } });
    expect(privateIpInput.value).toBe('192.168.1.10');
    expect(screen.getByText('私网 IP 不在 10.0.0.0/24 网段内')).toBeTruthy();

    fireEvent.change(privateIpInput, { target: { value: '10.0.8.10' } });
    expect(privateIpInput.value).toBe('10.0.8.10');
  });

  it('creates a persisted edge in online orchestration mode and saves it with the topology graph', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByTestId('topology-flow-edge-edge-switch-2-ecs-1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-2' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.12' } });
    fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'Valid123!' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));
    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    expect(validateAndSaveRangeTemplateMock).toHaveBeenLastCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'ecs-1',
              zoneKey: 'zone-1',
            }),
          ]),
          edges: expect.arrayContaining([
            expect.objectContaining({
              fromNodeId: 'switch-2',
              toNodeId: 'ecs-1',
            }),
          ]),
        }),
        scenarioTemplateSpec: expect.any(Object),
        compiledProvisionSpec: expect.any(Object),
        compiledSpec: expect.any(Object),
      }),
    );
    expect(validateAndSaveRangeTemplateMock.mock.lastCall?.[3]).toEqual(
      expect.objectContaining({
        scenarioTemplateSpec: expect.objectContaining({
          hosts: expect.arrayContaining([
            expect.objectContaining({
              key: 'ecs-1',
              accountPreset: expect.objectContaining({
                password: 'Valid123!',
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it('maps a valid ecs custom password into scenarioTemplateSpec accountPreset.password', () => {
    const scenarioTemplateSpec = buildScenarioTemplateSpecFromTopologyGraph({
      metadata: {
        name: '企业攻防靶场',
        slug: 'enterprise-range',
        version: 'v1.1.0',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        edges: [],
        nodes: [
          {
            id: 'switch-1',
            kind: 'switch',
            label: '交换机 1',
            zoneKey: 'core',
            cidr: '10.0.0.0/24',
            purpose: 'business-zone',
            description: '',
            aclRules: [],
            nat: {
              snatEnabled: false,
              dnatMappings: [],
            },
          },
          {
            id: 'ecs-1',
            kind: 'ecs',
            label: 'ECS 1',
            instanceName: 'ECS 1',
            hostName: 'ecs-1',
            zoneKey: 'core',
            role: 'host',
            privateIp: '10.0.0.21',
            customPassword: 'Valid123!',
            exposePublic: false,
            image: 'ubuntu_22_04_x64_20G_alibase',
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            imageId: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 1,
            memory: 2,
            description: '',
            bootPriority: 1,
            bootWaitSeconds: 0,
            dnatMappings: [],
            networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.21' }],
            portGroups: [],
            nics: [
              {
                id: 'ecs-1-nic-1',
                switchId: 'switch-1',
                privateIp: '10.0.0.21',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '',
            imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
            instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
          },
        ] as const,
      },
      defaults: {
        vpcCidr: '10.0.0.0/16',
      },
    });

    expect(scenarioTemplateSpec.hosts).toEqual([
      expect.objectContaining({
        key: 'ecs-1',
        accountPreset: expect.objectContaining({
          password: 'Valid123!',
        }),
      }),
    ]);
  });

  it('blocks saving when ecs custom password is invalid and surfaces the shared validation message', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'password-host-2' } });
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.22' } });
    fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'abcdefgh' } });

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'ECS 1 自定义密码不合法：Password must include at least three of uppercase, lowercase, number, and special character.',
        ),
      ).toBeTruthy();
    });

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('blocks topology detection when ecs custom password is invalid', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'detect-blocked-host' } });
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.23' } });
    fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'abcdefgh' } });

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'ECS 1 自定义密码不合法：Password must include at least three of uppercase, lowercase, number, and special character.',
        ),
      ).toBeTruthy();
    });

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('blocks publishing when ecs custom password is invalid', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'publish-blocked-host' } });
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.24' } });
    fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'abcdefgh' } });

    fireEvent.click(screen.getByRole('button', { name: '发布到平台' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'ECS 1 自定义密码不合法：Password must include at least three of uppercase, lowercase, number, and special character.',
        ),
      ).toBeTruthy();
    });

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(shareRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('creates canonical edges even when linking starts from ecs or switch', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByTestId('topology-flow-edge-edge-switch-2-ecs-3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    expect(screen.getByTestId('topology-flow-edge-edge-router-1-switch-2')).toBeTruthy();
  });

  it('deletes the selected node and removes its related persisted edges', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByRole('button', { name: /ECS 1/ })).toBeNull();
    expect(screen.queryByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('deletes a selected edge through the delete action', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const edge = screen.getByTestId('topology-flow-edge-edge-switch-1-ecs-2');
    fireEvent.click(edge);
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('clears the ecs nic switch binding when deleting a selected switch-to-ecs edge', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const edge = screen.getByTestId('topology-flow-edge-edge-switch-1-ecs-2');
    fireEvent.click(edge);
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByRole('combobox', { name: '交换机标识 1' }).textContent).toContain('未连接交换机');
  });

  it('clears invalid nic and dnat references when deleting a node', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    selectAdminOption('交换机标识 1', '交换机 1');

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    selectAdminOption('DNAT 目标主机 1', 'ECS 1');

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));

    expect(screen.getByText('暂无 DNAT 规则')).toBeTruthy();
  });

  it('rejects invalid links outside router -> switch and switch -> ecs in online orchestration mode', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByText('第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线')).toBeTruthy();
    expect(screen.queryByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('renders node-specific property drawer sections for ecs, switch, and router nodes', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByText('基础信息')).toBeTruthy();
    expect(screen.getAllByText('网卡配置').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('主机名')).toBeTruthy();
    expect(screen.queryByLabelText('镜像 ID')).toBeNull();
    expect(screen.getByLabelText('CPU')).toBeTruthy();
    expect(screen.getByLabelText('内存')).toBeTruthy();
    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('内存') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText('网卡 1')).toBeTruthy();
    expect(screen.getByLabelText('交换机标识 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加网卡' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除网卡 1' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('描述')).toBeNull();
    expect(screen.queryByText('出口配置')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByText('基础信息')).toBeTruthy();
    expect(screen.getByText('网段配置')).toBeTruthy();
    expect(screen.getByText('ACL 配置')).toBeTruthy();
    expect(screen.getByText('NAT 配置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加 ACL 规则' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加 DNAT 规则' })).toBeTruthy();
    expect(screen.queryByLabelText('区域用途')).toBeNull();
    expect(screen.queryByLabelText('镜像 ID')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    expect(screen.getByLabelText('路由描述')).toBeTruthy();
    expect(screen.queryByLabelText('交换机名称')).toBeNull();
  });

  it('opens node properties on right click without requiring a separate mode switch', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /交换机 1/ }));

    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
    expect(screen.queryByText('当前节点')).toBeNull();
  });

  it('keeps addition feedback while selections are managed by the flow canvas', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    expect(screen.getByText('已添加ECS 1，可继续补充属性和关系。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.queryByText('已选择连线起点，请点击目标节点完成连接。')).toBeNull();
  });

  it('clears addition feedback without reporting a successful automatic layout', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    expect(screen.getByText('已添加交换机 1，可继续补充属性和关系。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'flow layout all' }));

    expect(screen.queryByText('已添加交换机 1，可继续补充属性和关系。')).toBeNull();
    expect(screen.queryByText('已完成全部自动布局。')).toBeNull();
  });

  it('deduplicates repeated flow selection callbacks after a graph update', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow replay selection' }));

    await waitFor(() => expect(screen.getByLabelText('主机名')).toBeTruthy());
  });

  it('keeps a closed property panel closed until the user activates the same node again', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    expect(screen.getByLabelText('主机名')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起节点属性' }));
    expect(screen.queryByLabelText('主机名')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('主机名')).toBeTruthy();
  });

  it('creates new ECS nodes with 2 CPU and 2 GB memory', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);

    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('内存') as HTMLInputElement).value).toBe('2');
  });

  it('clears the selected property panel when the flow canvas clears its selection', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('主机名')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'flow clear selection' }));
    expect(screen.queryByLabelText('主机名')).toBeNull();
  });

  it('adds structured nic, acl, and dnat cards from the property panel actions', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('交换机标识 1')).toBeTruthy();
    fireEvent.click(screen.getByText('添加安全规则'));
    expect(screen.getByLabelText('安全方向 1-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加网卡' }));
    expect(screen.getByLabelText('交换机标识 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除网卡 2' }));
    expect(screen.queryByLabelText('交换机标识 2')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByLabelText('ACL 方向 1')).toBeTruthy();
    expect(screen.getByLabelText('DNAT 目标主机 1')).toBeTruthy();
  });

  it('shows startup fields and supports removing security, acl, and dnat rules', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('名称')).toBeTruthy();
    expect(screen.getByText('ECS')).toBeTruthy();
    expect(screen.queryByLabelText('启动优先级')).toBeNull();
    expect(screen.queryByLabelText('启动等待时间')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则' }));
    expect(screen.getByLabelText('安全方向 1-3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除安全规则 1-3' }));
    expect(screen.queryByLabelText('安全方向 1-3')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.queryByText('DNAT 用于配置公网到主机端口的入网映射，SNAT 用于开启网段主动出网。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByLabelText('ACL 方向 1')).toBeTruthy();
    expect(screen.getByLabelText('DNAT 目标主机 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除 ACL 规则 1' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 DNAT 规则 1' }));
    expect(screen.queryByLabelText('ACL 方向 1')).toBeNull();
    expect(screen.queryByLabelText('DNAT 目标主机 1')).toBeNull();
  });

  it('shows policy and priority fields for security and acl rules', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则' }));
    expect(screen.getByLabelText('安全策略 1-1')).toBeTruthy();
    expect(screen.getByLabelText('安全优先级 1-1')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    expect(screen.getByLabelText('ACL 策略 1')).toBeTruthy();
    expect(screen.getByLabelText('ACL 优先级 1')).toBeTruthy();
  });

  it('uses selects for direction and protocol style fields in rule editors', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则' }));
    expect(screen.getByRole('combobox', { name: '安全方向 1-1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '安全协议 1-1' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByRole('combobox', { name: 'ACL 方向 1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'ACL 协议 1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'DNAT 协议 1' })).toBeTruthy();
  });

  it('edits switch cidr through segmented subnet controls', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.change(screen.getByLabelText('CIDR 第一段'), { target: { value: '172' } });
    fireEvent.change(screen.getByLabelText('CIDR 第二段'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('CIDR 第三段'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '26' } });

    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('172');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('26');
    expect(screen.getByRole('button', { name: /交换机 1 172\.16\.5\.0\/26/ })).toBeTruthy();
  });

  it('uses selects for nic switch binding and dnat target host selection', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByRole('combobox', { name: '交换机标识 1' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByRole('combobox', { name: 'DNAT 目标主机 1' })).toBeTruthy();
  });

  it('does not render inferred edges when the saved topology has no explicit edges', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '1.0.0',
              nodes: [
                {
                  id: 'router-core',
                  kind: 'router',
                  label: '主路由',
                  routeRole: 'core',
                  egressType: 'internet',
                  bindEip: false,
                },
                {
                  id: 'switch-dmz',
                  kind: 'switch',
                  label: 'DMZ 交换机',
                  zoneKey: 'dmz',
                  cidr: '10.70.10.0/24',
                  purpose: 'public-entry',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'host-entry',
                  kind: 'ecs',
                  label: '边界主机',
                  instanceName: 'host-entry',
                  hostName: 'host-entry',
                  zoneKey: 'dmz',
                  role: 'entry',
                  privateIp: '10.70.10.10',
                  exposePublic: true,
                  image: 'aliyun_linux_3_x64_20G_alibase',
                  imageName: 'aliyun_linux_3_x64_20G_alibase',
                  imageId: 'aliyun_linux_3_x64_20G_alibase',
                  cpu: 2,
                  memory: 4,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.70.10.10' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'host-entry-nic-1',
                      switchId: 'switch-dmz',
                      privateIp: '10.70.10.10',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByTestId('topology-flow-canvas')).toBeTruthy();
    expect(screen.queryByTestId(/topology-flow-edge/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /边界主机/ }));

    expect(screen.getByLabelText('主机名')).toBeTruthy();
  });

  it('edits a node and keeps the change in local topology state', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((screen.getByLabelText('主机名') as HTMLInputElement).value).toBe('edge-host-1');
  });

  it('derives economy-first instance candidates from cpu and memory before validation payload is saved', async () => {
    validateAndSaveRangeTemplateMock.mockClear();

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '4' } });
    addDnatEntry();

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'ecs-1',
            cpu: 2,
            memory: 4,
            instanceType: 'ecs.e-c1m2.large',
            instanceTypeStrategy: {
              mode: 'prefer-list',
              preferredInstanceTypes: ['ecs.e-c1m2.large', 'ecs.u1-c1m2.large'],
            },
          }),
        ]),
      }),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-1-instance-type-policy',
        mode: 'prefer-list',
        preferredInstanceTypes: ['ecs.e-c1m2.large', 'ecs.u1-c1m2.large'],
      }),
    ]);
    expect(latestPayload?.compiledProvisionSpec?.runtimeSelections?.instanceTypePolicies).toEqual(
      expect.objectContaining({
        'ecs-1-instance-type-policy': expect.objectContaining({
          mode: 'prefer-list',
          preferredInstanceTypes: ['ecs.e-c1m2.large', 'ecs.u1-c1m2.large'],
        }),
      }),
    );
  });

  it('preserves an explicitly fixed economy instance type when topology detection recompiles the draft', async () => {
    validateAndSaveRangeTemplateMock.mockClear();

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/24',
                  purpose: 'business-zone',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 620, y: 180 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'core',
                  role: 'entry',
                  privateIp: '',
                  exposePublic: true,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 2,
                  memory: 2,
                  instanceType: 'ecs.e-c1m1.large',
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.13',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: {
                    mode: 'fixed',
                    instanceType: 'ecs.e-c1m1.large',
                  },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                  label: '交换机 1 -> ECS 1',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    addRouterConnection();
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'ecs-1',
            cpu: 2,
            memory: 2,
            zoneKey: 'zone-1',
            instanceType: 'ecs.e-c1m1.large',
            instanceTypeStrategy: {
              mode: 'fixed',
              instanceType: 'ecs.e-c1m1.large',
            },
          }),
        ]),
      }),
    );
    expect(latestPayload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          config: expect.objectContaining({
            cpu: 2,
            memory: 2,
            instanceType: 'ecs.e-c1m1.large',
          }),
        }),
      ]),
    );
    expect(latestPayload?.compiledProvisionSpec?.runtimeSelections?.instanceTypePolicies).toEqual(
      expect.objectContaining({
        'ecs-1-instance-type-policy': expect.objectContaining({
          mode: 'fixed',
          instanceType: 'ecs.e-c1m1.large',
        }),
      }),
    );
  });

  it('does not render the old property-panel helper copy or save button', () => {
    validateAndSaveRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.queryByText('节点配置')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存属性' })).toBeNull();
  });

  it('places 检测与保存 failure feedback beside the toolbar title', () => {
    const { container } = render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    const message = '拓扑检测未通过：至少需要一个 ECS 主机';
    const status = screen.getByRole('status');

    expect(status.textContent).toContain(message);
    expect(status.getAttribute('title')).toBe(status.textContent);
    expect(container.querySelector('.template-editor-toolbar-identity [role="status"]')).toBe(status);
    expect(container.querySelector('.template-editor-toolbar-copy > [role="status"]')).toBeNull();
    expect(container.querySelector('.template-editor-screen > p[role="status"]')).toBeNull();
  });

  it('saves a pure private topology without DNAT or unintended NAT resources', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1));
    const payload = validateAndSaveRangeTemplateMock.mock.calls[0]![3];
    expect(payload.compiledProvisionSpec).toMatchObject({ natGateways: [], eips: [], snatEntries: [], dnatEntries: [], hosts: [expect.objectContaining({ exposePublic: false })] });
  });

  it('saves mappings to multiple hosts through one shared DNAT EIP', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });

    fireEvent.click(screen.getByRole('button', { name: /ECS 2/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.14' } });

    addDnatEntry('ECS 1', 1);
    addDnatEntry('ECS 2', 2);
    fireEvent.change(screen.getByLabelText('DNAT 公网端口 2'), { target: { value: '8081' } });
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1));
    const payload = validateAndSaveRangeTemplateMock.mock.calls[0]![3];
    expect(payload.compiledProvisionSpec.dnatEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostKey: 'ecs-1', backendPrivateIp: '10.0.0.13', externalPort: 8080 }),
      expect.objectContaining({ hostKey: 'ecs-2', backendPrivateIp: '10.0.0.14', externalPort: 8081 }),
    ]));
    expect(payload.compiledProvisionSpec.eips).toEqual([expect.objectContaining({ key: 'eip-dnat-shared' })]);
  });

  it('allows topology detection when an ecs hostName is left blank', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/24',
                  purpose: 'business-zone',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 620, y: 180 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'zone-1',
                  role: 'entry',
                  privateIp: '10.0.0.10',
                  exposePublic: true,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 1,
                  memory: 2,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.0.0.10' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.10',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          hostName: '',
        }),
      ]),
    );
  });

  it('restores stored switch and ecs positions from the saved topology after refresh', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 400, y: 200 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/16',
                  purpose: 'business-zone',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 860, y: 360 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'core',
                  role: 'entry',
                  privateIp: '',
                  exposePublic: true,
                  image: 'aliyun_linux_3_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'aliyun_linux_3_x64_20G_alibase',
                  imageId: 'aliyun_linux_3_x64_20G_alibase',
                  cpu: 1,
                  memory: 2,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.13' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.13',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /交换机 1 10.0.0.0\/16/ }).getAttribute('style')).toContain('left: 400px');
    expect(screen.getByRole('button', { name: /ECS 1 10.0.0.13/ }).getAttribute('style')).toContain('left: 860px');
  });

  it('restores unsaved topology from local cache for the same template revision after refresh', () => {
    window.localStorage.setItem(
      'template-editor:topology-cache:template-1:1',
      JSON.stringify({
        persistedGraphSignature: JSON.stringify({ nodes: [], edges: [] }),
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              label: 'ECS 1',
              position: { x: 620, y: 180 },
              instanceName: 'ECS 1',
              hostName: 'ecs-1',
              zoneKey: 'core',
              role: 'host',
              privateIp: '',
              exposePublic: false,
              image: 'ubuntu_22_04_x64_20G_alibase',
              imageName: 'ubuntu_22_04_x64_20G_alibase',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
              cpu: 1,
              memory: 2,
              description: '',
              bootPriority: 1,
              bootWaitSeconds: 0,
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
              portGroups: [],
              nics: [
                {
                  id: 'ecs-1-nic-1',
                  switchId: '',
                  privateIp: '',
                  secondaryIps: [],
                  securityGroupRules: [],
                },
              ],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
          ],
          edges: [],
        },
      }),
    );

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
  });

  it('reloads the full topology by template id instead of replacing it with list summary data', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'mine'
        ? [
            {
              id: 'template-1',
              name: '企业攻防靶场',
              createdBy: 'test',
              ownerUserId: 'user-1',
              description: 'summary only',
              slug: 'enterprise-range',
              version: 'v1.1.0',
              visibility: 'private',
              currentDraftVersionId: 'draft-1',
              currentPublishedVersionId: null,
              createdAt: '2026-07-16T00:00:00.000Z',
              updatedAt: '2026-07-16T00:00:00.000Z',
              nodeCount: 1,
              zoneCount: 1,
              hostCount: 1,
            },
          ]
        : [],
    );
    fetchRangeTemplateByIdMock.mockResolvedValue(normalizeTemplateFixture({
      id: 'template-1',
      name: '企业攻防靶场',
      createdBy: 'test',
      ownerUserId: 'user-1',
      description: 'full draft',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      visibility: 'private',
      currentDraftVersionId: 'draft-1',
      currentPublishedVersionId: null,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      currentDraftVersion: {
        id: 'draft-1',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              label: 'ECS 1',
              position: { x: 620, y: 180 },
              instanceName: 'ECS 1',
              hostName: 'ecs-1',
              zoneKey: 'core',
              role: 'host',
              privateIp: '',
              exposePublic: false,
              image: 'ubuntu_22_04_x64_20G_alibase',
              imageName: 'ubuntu_22_04_x64_20G_alibase',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
              cpu: 1,
              memory: 2,
              description: '',
              bootPriority: 1,
              bootWaitSeconds: 0,
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
              portGroups: [],
              nics: [
                {
                  id: 'ecs-1-nic-1',
                  switchId: '',
                  privateIp: '',
                  secondaryIps: [],
                  securityGroupRules: [],
                },
              ],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
          ],
          edges: [],
        },
      },
      currentPublishedVersion: null,
    } as never));

    render(<TemplateEditorScreen templateId="template-1" />);

    expect(await screen.findByRole('button', { name: /ECS 1/ })).toBeTruthy();
    expect(fetchRangeTemplateByIdMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
    );
  });

  it('ignores stale local cache when the server topology has changed', () => {
    window.localStorage.setItem(
      'template-editor:topology-cache:template-1:1',
      JSON.stringify({
        persistedGraphSignature: JSON.stringify({
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              cpu: 1,
              memory: 2,
            },
          ],
          edges: [],
        }),
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              label: 'ECS 1',
              position: { x: 620, y: 180 },
              instanceName: 'ECS 1',
              hostName: 'ecs-1',
              zoneKey: 'core',
              role: 'host',
              privateIp: '',
              exposePublic: false,
              image: 'ubuntu_22_04_x64_20G_alibase',
              imageName: 'ubuntu_22_04_x64_20G_alibase',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
              cpu: 1,
              memory: 2,
              description: '',
              bootPriority: 1,
              bootWaitSeconds: 0,
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
              portGroups: [],
              nics: [
                {
                  id: 'ecs-1-nic-1',
                  switchId: '',
                  privateIp: '',
                  secondaryIps: [],
                  securityGroupRules: [],
                },
              ],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
          ],
          edges: [],
        },
      }),
    );

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 620, y: 180 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'core',
                  role: 'host',
                  privateIp: '',
                  exposePublic: false,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 2,
                  memory: 4,
                  instanceType: 'ecs.e-c1m2.large',
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: '',
                      privateIp: '',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m2.large' },
                },
              ],
              edges: [],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('内存') as HTMLInputElement).value).toBe('4');
  });

  it('preserves persisted top-level instanceType when reloading saved topology graph', async () => {
    validateAndSaveRangeTemplateMock.mockClear();

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/24',
                  purpose: 'business-zone',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 620, y: 180 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'zone-1',
                  role: 'entry',
                  privateIp: '10.0.0.13',
                  exposePublic: true,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 8,
                  memory: 16,
                  instanceType: 'ecs.custom.saved',
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.0.0.13' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.13',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'persisted-instance-type-host' } });
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    expect(screen.getByDisplayValue('persisted-instance-type-host')).toBeTruthy();
    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          instanceType: 'ecs.custom.saved',
          instanceTypeStrategy: {
            mode: 'fixed',
            instanceType: 'ecs.custom.saved',
          },
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-1-instance-type-policy',
        mode: 'fixed',
        instanceType: 'ecs.custom.saved',
      }),
    ]);
    expect(latestPayload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          type: 'host',
          config: expect.objectContaining({
            instanceType: 'ecs.custom.saved',
            instanceTypeStrategy: {
              mode: 'fixed',
              instanceType: 'ecs.custom.saved',
            },
          }),
        }),
      ]),
    );
  });

  it('stores platformImageAssetId, imageName, imageId, and final instanceType when validating an ecs node', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.18' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'catalog-backed-host' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];

    expect(latestPayload?.topologyGraph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          platformImageAssetId: 'platform-image-1',
          image: 'Ubuntu 24.04 LTS',
          imageName: 'Ubuntu 24.04 LTS',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
          instanceType: 'ecs.e-c1m2.xlarge',
          instanceTypeStrategy: {
            mode: 'prefer-list',
            preferredInstanceTypes: ['ecs.e-c1m2.xlarge', 'ecs.u1-c1m2.xlarge'],
          },
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.imagePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1-image-policy',
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1-instance-type-policy',
          mode: 'prefer-list',
          preferredInstanceTypes: ['ecs.e-c1m2.xlarge', 'ecs.u1-c1m2.xlarge'],
        }),
      ]),
    );
    expect(latestPayload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          type: 'host',
          config: expect.objectContaining({
            platformImageAssetId: 'platform-image-1',
            imageId: 'ubuntu_24_04_x64_20G_alibase',
            instanceType: 'ecs.e-c1m2.xlarge',
            instanceTypeStrategy: {
              mode: 'prefer-list',
              preferredInstanceTypes: ['ecs.e-c1m2.xlarge', 'ecs.u1-c1m2.xlarge'],
            },
          }),
        }),
      ]),
    );
  });

  it('validates and saves one exact compiled topology payload with its revision', async () => {
    validateAndSaveRangeTemplateMock.mockClear();
    validateAndSaveRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      status: 'private',
      visibility: 'private',
      revision: 4,
      topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          status: 'private',
          revision: 3,
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });
    expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        expectedRevision: 3,
        topologyGraph: expect.any(Object),
        topologySpec: expect.any(Object),
        compiledSpec: expect.any(Object),
      }),
    );

    const latestPayload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.compiledSpec).toBeTruthy();
    expect(latestPayload?.scenarioTemplateSpec).toBeTruthy();
    expect(latestPayload?.compiledProvisionSpec).toBeTruthy();
    expect(latestPayload?.compiledSpec).not.toHaveProperty('topologySpec');
    expect(latestPayload?.compiledSpec?.resources[0]).toEqual(expect.objectContaining({
      id: 'ecs-1',
      type: 'host',
      provider: 'alibaba_cloud',
      config: expect.objectContaining({
        dnatMappings: [],
        label: 'ECS 1',
        zoneKey: 'zone-1',
        role: 'host',
        privateIp: '10.0.0.13',
        exposePublic: true,
        image: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        imageName: 'Ubuntu 24.04 LTS',
        instanceName: 'ECS 1',
        hostName: 'edge-host-1',
        cpu: 2,
        memory: 2,
        instanceType: 'ecs.e-c1m1.large',
        networkInterfaces: [
          expect.objectContaining({
            zoneKey: 'core',
            privateIp: '',
          }),
        ],
        nics: [
          expect.objectContaining({
            switchId: 'switch-2',
            privateIp: '10.0.0.13',
          }),
        ],
        portGroups: [],
        initScript: '',
        imageStrategy: {
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        },
        instanceTypeStrategy: {
          mode: 'prefer-list',
          preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
        },
      }),
    }));
    expect(latestPayload?.scenarioTemplateSpec).toEqual(
      expect.objectContaining({
        schemaVersion: '1.0.0',
        topology: expect.objectContaining({
          vpcCidr: '10.0.0.0/16',
          entryHostKey: 'ecs-1',
        }),
        hosts: expect.arrayContaining([
          expect.objectContaining({
            key: 'ecs-1',
            name: 'edge-host-1',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.13',
          }),
        ]),
        runtimePreferences: expect.objectContaining({
          instanceTypePolicies: [
            expect.objectContaining({
              key: 'ecs-1-instance-type-policy',
              mode: 'prefer-list',
              preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
            }),
          ],
        }),
      }),
    );
    expect(latestPayload?.compiledProvisionSpec).toEqual(
      expect.objectContaining({
        schemaVersion: '1.0.0',
        topology: expect.objectContaining({
          vpcCidr: '10.0.0.0/16',
          entryHostKey: 'ecs-1',
        }),
        hosts: expect.arrayContaining([
          expect.objectContaining({
            key: 'ecs-1',
            name: 'edge-host-1',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.13',
          }),
        ]),
        runtimeSelections: expect.objectContaining({
          instanceTypePolicies: expect.objectContaining({
            'ecs-1-instance-type-policy': expect.objectContaining({
              mode: 'prefer-list',
              preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
            }),
          }),
        }),
      }),
    );
    expect(screen.getByText('拓扑检测通过，已保存')).toBeTruthy();
  });

  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('creates a new %s topology only after the complete local canvas passes detection', async provider => {
    if (provider === 'tencent_cloud') {
      writeAdminSession({ token: 'dev-admin-token', profile: { id: 'template-author-fixture', username: 'fixture-author', role: 'admin' } });
      setCloudWorkspaceSelection('template-author-fixture', 'tencent-workspace');
      workspaceState.value = { workspace: { id: 'tencent-workspace', provider, isReadOnly: false, capabilities: { provisioning: true } } };
      fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'platform-image-1', provider, accountUid: '100001', regionId: 'ap-shanghai', imageId: 'img-tencent-fixture',
        displayName: 'Ubuntu 24.04 LTS', enabled: true, tags: [], architecture: 'x86_64', minimumSystemDiskSize: 80 }] });
      fetchInstanceTypeAvailabilityMock.mockImplementation(async (_url, _token, cpu, memory) => ({ cpu, memory, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1', exactAvailable: true, warning: null,
        matches: [{ instanceTypeId: 'S5.MEDIUM2', cpu, memoryGiB: memory, family: 'S5', generation: 'S5', architecture: 'X86_64' }] }));
    }
    const draftKey = workspaceStorageKey('template-editor:new-template');
    window.sessionStorage.setItem(
      draftKey,
      JSON.stringify({
        name: '新建攻防拓扑',
        description: '首次检测通过后创建',
      }),
    );
    createRangeTemplateMock.mockResolvedValue({
      id: 'template-created',
      name: '新建攻防拓扑',
      description: '首次检测通过后创建',
      slug: 'new-range-created',
      status: 'private',
      visibility: 'private',
      revision: 1,
      topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
    });

    render(<TemplateEditorScreen templateId="new" />);

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'new-edge-host' } });
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    addDnatEntry();
    if (provider === 'tencent_cloud') fireEvent.click(screen.getByLabelText('允许访问互联网（SNAT）'));
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(createRangeTemplateMock).toHaveBeenCalledTimes(1);
    });
    expect(createRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({
        name: '新建攻防拓扑',
        description: '首次检测通过后创建',
        topologyGraph: expect.any(Object),
        topologySpec: expect.any(Object),
        scenarioTemplateSpec: expect.any(Object),
        compiledProvisionSpec: expect.any(Object),
        compiledSpec: expect.any(Object),
      }),
    );
    expect(createRangeTemplateMock.mock.calls[0]?.[2]).not.toHaveProperty('expectedRevision');
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    const createdPayload = createRangeTemplateMock.mock.calls[0]?.[2];
    expect(createdPayload.scenarioTemplateSpec.metadata.cloudProvider).toBe(provider);
    expect(createdPayload.compiledProvisionSpec.identity.cloudProvider).toBe(provider);
    expect(createdPayload.compiledSpec.resources.every((resource: { provider: string }) => resource.provider === provider)).toBe(true);
    if (provider === 'tencent_cloud') expect(JSON.stringify(createdPayload.scenarioTemplateSpec.runtimePreferences.instanceTypePolicies)).not.toContain('ecs.');
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios/template-created');
  });

  it('keeps a new topology draft cache valid across consecutive refreshes', async () => {
    window.sessionStorage.setItem(
      'template-editor:new-template',
      JSON.stringify({ name: '缓存拓扑', description: '刷新后恢复' }),
    );

    const firstRender = render(<TemplateEditorScreen templateId="new" />);
    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));

    await waitFor(() => {
      const draft = JSON.parse(window.sessionStorage.getItem('template-editor:new-template') ?? '{}');
      expect(draft.draftId).toEqual(expect.any(String));
      expect(window.localStorage.getItem(`template-editor:topology-cache:new:${draft.draftId}:0`)).toBeTruthy();
    });
    firstRender.unmount();

    const secondRender = render(<TemplateEditorScreen templateId="new" />);
    expect(screen.getByRole('button', { name: /交换机 1 10\.0\.0\.0\/24/ })).toBeTruthy();
    secondRender.unmount();

    render(<TemplateEditorScreen templateId="new" />);
    expect(screen.getByRole('button', { name: /交换机 1 10\.0\.0\.0\/24/ })).toBeTruthy();
  });

  it('does not restore a different new topology draft cache', () => {
    window.sessionStorage.setItem(
      'template-editor:new-template',
      JSON.stringify({ draftId: 'draft-b', name: '草稿 B', description: '' }),
    );
    window.localStorage.setItem(
      'template-editor:topology-cache:new:0',
      JSON.stringify({
        persistedGraphSignature: JSON.stringify({ nodes: [], edges: [] }),
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [{
            id: 'switch-draft-a',
            kind: 'switch',
            label: '草稿 A 交换机',
            zoneKey: 'draft-a',
            cidr: '10.91.0.0/24',
            purpose: 'business-zone',
            position: { x: 240, y: 180 },
            aclRules: [],
            nat: { snatEnabled: false, dnatMappings: [] },
          }],
          edges: [],
        },
      }),
    );

    render(<TemplateEditorScreen templateId="new" />);

    expect(screen.queryByRole('button', { name: /草稿 A 交换机/ })).toBeNull();
  });

  it('blocks publishing when the canvas has unsaved topology changes', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '发布到平台' }));

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(screen.getByText('请先点击“检测与保存”，再发布到平台。')).toBeTruthy();
  });

  it('warns when the current topology is already published', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '发布到平台' }));

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
    expect(shareRangeTemplateMock).not.toHaveBeenCalled();
    expect(screen.getByText('当前拓扑已发布到平台。')).toBeTruthy();
  });

  it('rejects duplicate nic private ips on the same switch during topology detection', async () => {
    validateAndSaveRangeTemplateMock.mockClear();

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/16',
                  purpose: 'business-zone',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'ecs-1',
                  kind: 'ecs',
                  label: 'ECS 1',
                  position: { x: 620, y: 180 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'core',
                  role: 'entry',
                  privateIp: '',
                  exposePublic: true,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 1,
                  memory: 2,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.4',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
                {
                  id: 'ecs-2',
                  kind: 'ecs',
                  label: 'ECS 2',
                  position: { x: 620, y: 300 },
                  instanceName: 'ECS 2',
                  hostName: 'ecs-2',
                  zoneKey: 'core',
                  role: 'host',
                  privateIp: '',
                  exposePublic: false,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  platformImageAssetId: 'platform-image-1',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 1,
                  memory: 2,
                  description: '',
                  bootPriority: 2,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-2-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.4',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(
        screen.getByText(/拓扑检测未通过：交换机 1 中存在重复 IP：10\.0\.0\.4/),
      ).toBeTruthy();
    });
    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('updates node positions in the local topology state after the flow canvas commits a drag batch', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'flow commit positions' }));

    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('left: 180px');
    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('top: 220px');
  });

  it('publishes the saved private topology to the platform', async () => {
    shareRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      status: 'published',
      visibility: 'platform',
      revision: 5,
      topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-publish' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));
    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: '发布到平台' })[0]!);

    await waitFor(() => {
      expect(shareRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        { expectedRevision: 4 },
      );
    });

    expect(screen.getByText('拓扑已发布到平台。')).toBeTruthy();
    expect(screen.getByText('已发布')).toBeTruthy();
  });

  it('shows structured publish precheck errors when publishing fails', async () => {
    shareRangeTemplateMock.mockRejectedValue(
      new AdminApiError(400, '编排发布失败', {
        message: [
          'Missing switch resource for network zone: office',
          'Compiled public entry host must expose public access: dmz-entry',
        ],
      }),
    );

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-fail' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    selectAdminOption('交换机标识 1', '交换机 1');
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));
    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: '发布到平台' })[0]!);

    await waitFor(() => {
      expect(screen.getByText(/编排发布失败：Missing switch resource for network zone: office；Compiled public entry host must expose public access: dmz-entry/)).toBeTruthy();
    });
  });


  it('does not expose extended network resource entry points in phase one', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: /NAT 网关/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^EIP/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ACL/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /安全组规则/i })).toBeNull();
  });

  it('commits valid flow edits to history and the save payload without persisting before detection', async () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          revision: 3,
          status: 'private',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: null,
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow connect valid' }));
    addRouterConnection();
    fireEvent.click(screen.getByRole('button', { name: 'flow commit positions' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow commit viewport' }));

    expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'flow undo' }));
    expect(screen.getByTestId('topology-flow-canvas').getAttribute('data-viewport')).toBe('null');
    fireEvent.click(screen.getByRole('button', { name: 'flow redo' }));
    expect(screen.getByTestId('topology-flow-canvas').getAttribute('data-viewport')).toBe('{"x":-80,"y":40,"zoom":1.2}');
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.12' } });
    fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'Valid123!' } });
    addDnatEntry();
    fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

    await waitFor(() => {
      expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const payload = validateAndSaveRangeTemplateMock.mock.calls[0]?.[3] as {
      topologyGraph?: { edges?: unknown[]; viewport?: unknown };
    };
    expect(payload.topologyGraph?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: 'switch-2', toNodeId: 'ecs-1' }),
        expect.objectContaining({ fromNodeId: 'router-3', toNodeId: 'switch-2' }),
      ]),
    );
    expect(payload.topologyGraph?.viewport).toEqual({ x: -80, y: 40, zoom: 1.2 });
  });

  it('undoes property drafts without losing the preceding connection or drag snapshot', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          revision: 3,
          status: 'private',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: null,
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow connect valid' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow commit positions' }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'app-server' } });

    fireEvent.click(screen.getByRole('button', { name: 'flow undo' }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((screen.getByLabelText('主机名') as HTMLInputElement).value).toBe('ecs-1');
    expect(screen.getByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeTruthy();
    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('left: 300px');

    fireEvent.click(screen.getByRole('button', { name: 'flow redo' }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((screen.getByLabelText('主机名') as HTMLInputElement).value).toBe('app-server');
    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('left: 300px');
  });

  it('rejects invalid flow connections without creating a history entry', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          revision: 3,
          status: 'private',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: null,
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow connect valid' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow connect invalid' }));

    expect(screen.getByText('不能将节点连接到自己')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'flow undo' }));

    expect(screen.queryByTestId('topology-flow-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('uses the same bulk delete callback for the flow canvas and restores the property panel on a new single selection', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          revision: 3,
          status: 'private',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: null,
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.click(screen.getByRole('button', { name: '虚拟主机 virtual client' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow select multiple nodes' }));

    expect(screen.queryByLabelText('主机名')).toBeNull();
    expect(screen.getByRole('button', { name: '删除选中' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'flow delete selection' }));

    expect(screen.queryByRole('button', { name: /ECS 1/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /交换机 1/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起节点属性' }));
    expect(screen.queryByLabelText('交换机名称')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
  });
});

describe('template authoring regression recovery', () => {
  const emptyTemplate = {id:'audit',name:'Audit',slug:'audit',revision:1,status:'private' as const,visibility:'private' as const,topologyGraph:{schemaVersion:'2.0.0',nodes:[],edges:[]}};
  it('keeps node IDs unique after deleting an earlier ECS', () => {
    render(<TemplateEditorScreen template={emptyTemplate} />);
    fireEvent.click(screen.getByRole('button',{name:'路由器 router'}));
    fireEvent.click(screen.getByRole('button',{name:'交换机 switch'}));
    fireEvent.click(screen.getByRole('button',{name:'虚拟主机 virtual client'}));
    fireEvent.click(screen.getByRole('button',{name:'虚拟主机 virtual client'}));
    fireEvent.contextMenu(screen.getByRole('button',{name:/^ECS 1$/}));
    fireEvent.click(screen.getByRole('button',{name:'删除选中'}));
    fireEvent.click(screen.getByRole('button',{name:'虚拟主机 virtual client'}));
    const graph=JSON.parse(window.localStorage.getItem('template-editor:topology-cache:audit:1')!).topologyGraph;
    const ids=graph.nodes.map((node:any)=>node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('uses an available fixed-VPC CIDR for the fourth Switch', () => {
    render(<TemplateEditorScreen template={emptyTemplate} />);
    for(let i=0;i<4;i++)fireEvent.click(screen.getByRole('button',{name:'交换机 switch'}));
    const graph=JSON.parse(window.localStorage.getItem('template-editor:topology-cache:audit:1')!).topologyGraph;
    expect(graph.nodes[3].cidr).toBe('10.0.1.0/24');
  });
  it('shows template load errors and allows a retry',async()=>{
    fetchRangeTemplateByIdMock.mockRejectedValueOnce(new Error('Audit fetch failure')).mockResolvedValueOnce(emptyTemplate);
    render(<TemplateEditorScreen templateId="missing-audit" />);
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Audit fetch failure'));
    fireEvent.click(screen.getByRole('button',{name:'重试加载'}));
    await waitFor(()=>expect(screen.getByRole('heading',{name:'Audit'})).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps NIC and ACL IDs unique after deletion and addition',async()=>{
    render(<TemplateEditorScreen template={emptyTemplate} />);
    fireEvent.click(screen.getByRole('button',{name:'虚拟主机 virtual client'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'添加网卡'})).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'添加网卡'}));
    fireEvent.click(screen.getByRole('button',{name:'添加网卡'}));
    fireEvent.click(screen.getByRole('button',{name:'删除网卡 2'}));
    fireEvent.click(screen.getByRole('button',{name:'添加网卡'}));
    let graph=JSON.parse(window.localStorage.getItem('template-editor:topology-cache:audit:1')!).topologyGraph;
    expect(new Set(graph.nodes[0].nics.map((nic:any)=>nic.id)).size).toBe(3);
    fireEvent.click(screen.getByRole('button',{name:'交换机 switch'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'添加 ACL 规则'})).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'添加 ACL 规则'}));
    fireEvent.click(screen.getByRole('button',{name:'添加 ACL 规则'}));
    fireEvent.click(screen.getByRole('button',{name:'删除 ACL 规则 1'}));
    fireEvent.click(screen.getByRole('button',{name:'添加 ACL 规则'}));
    graph=JSON.parse(window.localStorage.getItem('template-editor:topology-cache:audit:1')!).topologyGraph;
    expect(new Set(graph.nodes[1].aclRules.map((rule:any)=>rule.key)).size).toBe(2);
  });
  it('removes the corresponding edge when deleting a bound secondary NIC',async()=>{
    render(<TemplateEditorScreen template={{...emptyTemplate,topologyGraph:{schemaVersion:'2.0.0',nodes:[
      {id:'s1',kind:'switch',label:'DMZ',zoneKey:'z1',cidr:'10.0.1.0/24'},
      {id:'s2',kind:'switch',label:'Private',zoneKey:'z2',cidr:'10.0.2.0/24'},
      {id:'h',kind:'ecs',label:'Host',zoneKey:'z1',privateIp:'10.0.1.10',nics:[{id:'n1',switchId:'s1',privateIp:'10.0.1.10',secondaryIps:[],securityGroupRules:[]},{id:'n2',switchId:'s2',privateIp:'10.0.2.10',secondaryIps:[],securityGroupRules:[]}]}],edges:[{id:'s1h',fromNodeId:'s1',toNodeId:'h',relationType:'manual'},{id:'s2h',fromNodeId:'s2',toNodeId:'h',relationType:'manual'}]}}} />);
    fireEvent.contextMenu(screen.getByRole('button',{name:/^Host /}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'删除网卡 2'})).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'删除网卡 2'}));
    const graph=JSON.parse(window.localStorage.getItem('template-editor:topology-cache:audit:1')!).topologyGraph;
    expect(graph.nodes.find((node:any)=>node.id==='h').nics).toHaveLength(1);
    expect(graph.edges.map((edge:any)=>edge.id)).toEqual(['s1h']);
    fireEvent.click(screen.getByRole('button',{name:/^Private /}));
    fireEvent.click(screen.getByRole('button',{name:/^Host /}));
    expect(screen.getByText(/已创建连线：Private -> Host/)).toBeTruthy();
  });
});

describe('final authoring coverage: recreated nodes', () => {
  const emptyTemplate = { id: 'recreated', name: 'Recreated', slug: 'recreated', revision: 1, status: 'private' as const, visibility: 'private' as const, topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] } };
  const graphFromCache = () => JSON.parse(window.localStorage.getItem('template-editor:topology-cache:recreated:1')!).topologyGraph;

  it('deletes and recreates a Router without colliding with remaining imported node IDs', () => {
    render(<TemplateEditorScreen template={{ ...emptyTemplate, topologyGraph: { schemaVersion: '2.0.0', nodes: [
      { id: 'router-1', kind: 'router', label: 'Router', routeRole: 'egress', egressType: 'internet', bindEip: false },
      { id: 'router-3', kind: 'switch', label: 'Reserved router ID', zoneKey: 'one', cidr: '10.0.0.0/24' },
      { id: 'switch-4', kind: 'switch', label: 'Remaining switch', zoneKey: 'two', cidr: '172.16.0.0/24' },
    ], edges: [] } }} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Router VPC 根节点' }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    expect(graphFromCache().nodes.some((node: { kind: string }) => node.kind === 'router')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '路由器 router' }));
    const graph = graphFromCache();
    const ids = graph.nodes.map((node: { id: string }) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.nodes.filter((node: { kind: string }) => node.kind === 'router')).toHaveLength(1);
    expect(graph.nodes.find((node: { kind: string }) => node.kind === 'router').id).toBe('router-4');
    expect(ids).toContain('router-3');
    fireEvent.click(screen.getByRole('button', { name: '路由器 router' }));
    expect(screen.getByText('当前拓扑只允许一个 Router。')).toBeTruthy();
    expect(graphFromCache().nodes).toHaveLength(3);
  });

  it('deletes an earlier Switch and recreates it with unique node and zone keys', () => {
    render(<TemplateEditorScreen template={emptyTemplate} />);
    fireEvent.click(screen.getByRole('button', { name: '路由器 router' }));
    for (let index = 0; index < 3; index += 1) fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: '交换机 1 10.0.0.0/24' }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    expect(graphFromCache().nodes.some((node: { id: string }) => node.id === 'switch-2')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
    const graph = graphFromCache();
    const ids = graph.nodes.map((node: { id: string }) => node.id);
    const switches = graph.nodes.filter((node: { kind: string }) => node.kind === 'switch');
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(switches.map((node: { zoneKey: string }) => node.zoneKey)).size).toBe(3);
    expect(ids).toEqual(['router-1', 'switch-3', 'switch-4', 'switch-5']);
    expect(switches.find((node: { id: string }) => node.id === 'switch-5').cidr).toBe('10.0.0.0/24');
  });
});

it.each(['missing host', 'unattached NIC'])('checks every DNAT mapping and rejects a later mapping with %s', async (invalidTarget) => {
  const mapped = { key: 'valid-first', targetHostId: 'host', externalPort: 8080, internalPort: 80, protocol: 'tcp' };
  const invalid = { key: 'invalid-later', targetHostId: invalidTarget === 'missing host' ? 'missing-host' : 'host', externalPort: 8081, internalPort: 80, protocol: 'tcp' };
  const nodes = [
    { id: 'router', kind: 'router', label: 'Router', routeRole: 'egress', egressType: 'internet', bindEip: false },
    { id: 'switch-a', kind: 'switch', label: 'A', zoneKey: 'a', cidr: '10.0.0.0/24', purpose: 'internal', aclRules: [], nat: { snatEnabled: false, dnatMappings: invalidTarget === 'missing host' ? [mapped, invalid] : [mapped] } },
    { id: 'switch-b', kind: 'switch', label: 'B', zoneKey: 'b', cidr: '10.0.1.0/24', purpose: 'internal', aclRules: [], nat: { snatEnabled: false, dnatMappings: invalidTarget === 'unattached NIC' ? [invalid] : [] } },
    { id: 'host', kind: 'ecs', label: 'Host', zoneKey: 'a', role: 'host', privateIp: '10.0.0.10', exposePublic: false, platformImageAssetId: 'platform-image-1', image: 'Ubuntu 24.04 LTS', imageName: 'Ubuntu 24.04 LTS', imageId: 'ubuntu_24_04_x64_20G_alibase', cpu: 1, memory: 2, dnatMappings: [], networkInterfaces: [], portGroups: [], nics: [{ id: 'primary', switchId: 'switch-a', privateIp: '10.0.0.10', secondaryIps: [], securityGroupRules: [] }], initScript: '', imageStrategy: { mode: 'fixed', imageId: 'ubuntu_24_04_x64_20G_alibase' }, instanceTypeStrategy: { mode: 'auto' } },
  ];
  render(<TemplateEditorScreen template={{ id: 'target-validation', name: 'Targets', slug: 'targets', revision: 1, status: 'private', topologyGraph: { schemaVersion: '2.0.0', nodes, edges: [
    { id: 'router-a', fromNodeId: 'router', toNodeId: 'switch-a', relationType: 'manual' },
    { id: 'router-b', fromNodeId: 'router', toNodeId: 'switch-b', relationType: 'manual' },
    { id: 'a-host', fromNodeId: 'switch-a', toNodeId: 'host', relationType: 'manual' },
  ] } }} />);
  fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));
  const error = invalidTarget === 'missing host' ? 'DNAT 目标 ECS 不存在：missing-host' : 'DNAT 目标 ECS 未连接到交换机：invalid-later';
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain(error));
  expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();
});
