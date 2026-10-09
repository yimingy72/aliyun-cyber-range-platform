import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TopologyFlowCanvasMockProps = {
  mode?: 'edit' | 'readonly';
  edges: Array<{ id: string }>;
  nodes: Array<{ id: string; label: string; kind: string }>;
  onAddNode?: (kind: 'router' | 'switch' | 'ecs') => void;
  onConnect?: (connection: { source: string; target: string }) => void;
  onDeleteSelection?: () => void;
  onLayoutAll?: () => void;
  onNodeActivate?: (nodeId: string) => void;
  onPositionsCommit?: (positions: Array<{ id: string; position: { x: number; y: number } }>) => void;
  onRedo?: () => void;
  onSelectionChange?: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
  onUndo?: () => void;
  onViewportCommit?: (viewport: { x: number; y: number; zoom: number }) => void;
};

function TopologyFlowCanvasMock({
  edges,
  mode = 'edit',
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
}: TopologyFlowCanvasMockProps) {
  const switchNode = nodes.find((node) => node.kind === 'switch');
  const ecsNode = nodes.find((node) => node.kind === 'ecs');

  return (
    <section data-mode={mode} data-testid="topology-flow-workbench">
      <output data-testid="flow-edge-count">{edges.length}</output>
      <button onClick={() => onAddNode?.('ecs')} type="button">flow add ecs</button>
      <button
        disabled={!switchNode || !ecsNode}
        onClick={() => {
          if (switchNode && ecsNode) {
            onConnect?.({ source: switchNode.id, target: ecsNode.id });
          }
        }}
        type="button"
      >
        flow connect switch ecs
      </button>
      <button onClick={() => onDeleteSelection?.()} type="button">flow delete selection</button>
      <button
        onClick={() => onPositionsCommit?.(
          nodes.map((node, index) => ({
            id: node.id,
            position: { x: 160 + index * 120, y: 220 + index * 80 },
          })),
        )}
        type="button"
      >
        flow commit positions
      </button>
      <button onClick={() => onViewportCommit?.({ x: -80, y: 40, zoom: 1.2 })} type="button">
        flow commit viewport
      </button>
      <button onClick={() => onLayoutAll?.()} type="button">flow layout all</button>
      <button onClick={() => onUndo?.()} type="button">flow undo</button>
      <button onClick={() => onRedo?.()} type="button">flow redo</button>
      {nodes.map((node) => (
        <button
          key={node.id}
          onClick={() => {
            onSelectionChange?.({ nodeIds: [node.id], edgeIds: [] });
            onNodeActivate?.(node.id);
          }}
          type="button"
        >
          {node.label}
        </button>
      ))}
    </section>
  );
}

function createValidTopologyGraph(ecsLabel = 'checker') {
  return {
    schemaVersion: '2.0.0',
    nodes: [
      {
        id: 'router-1',
        kind: 'router',
        label: 'Router',
        routeRole: 'egress',
        egressType: 'internet',
        bindEip: false,
      },
      {
        id: 'switch-1',
        kind: 'switch',
        label: 'DMZ 交换机',
        zoneKey: 'dmz',
        cidr: '10.0.10.0/24',
        purpose: 'public-entry',
        nat: {
          snatEnabled: false,
          dnatMappings: [{
            key: 'dnat-entry',
            targetHostId: 'host-1',
            externalPort: 22,
            internalPort: 22,
            protocol: 'tcp',
          }],
        },
      },
      {
        id: 'host-1',
        kind: 'ecs',
        label: ecsLabel,
        zoneKey: 'dmz',
        role: 'entry',
        privateIp: '10.0.10.10',
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
        nics: [{
          id: 'host-1-nic-1',
          switchId: 'switch-1',
          privateIp: '10.0.10.10',
          secondaryIps: [],
          securityGroupRules: [],
        }],
      },
    ],
    edges: [
      { id: 'edge-router-switch', fromNodeId: 'router-1', toNodeId: 'switch-1' },
      { id: 'edge-switch-ecs', fromNodeId: 'switch-1', toNodeId: 'host-1' },
    ],
  };
}

const {
  fetchRangeInstanceDetailMock,
  fetchInstanceTypeAvailabilityMock,
  fetchPlatformImagesMock,
  fetchProvisionJobDetailMock,
  saveRangeInstanceDraftMock,
  discardRangeInstanceDraftMock,
  applyRangeInstanceDraftMock,
  syncRangeInstanceTemplateMock,
  runRangeInstanceNodeActionMock,
  writeTextMock,
  pushMock,
  replaceMock,
  routerMock,
  sessionState,
  workspaceState,
} = vi.hoisted(() => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();

  return {
    fetchRangeInstanceDetailMock: vi.fn(),
    fetchInstanceTypeAvailabilityMock: vi.fn(),
    fetchPlatformImagesMock: vi.fn(),
    fetchProvisionJobDetailMock: vi.fn(),
    saveRangeInstanceDraftMock: vi.fn(),
    discardRangeInstanceDraftMock: vi.fn(),
    applyRangeInstanceDraftMock: vi.fn(),
    syncRangeInstanceTemplateMock: vi.fn(),
    runRangeInstanceNodeActionMock: vi.fn(),
    writeTextMock: vi.fn(),
    pushMock,
    replaceMock,
    routerMock: {
      push: pushMock,
      replace: replaceMock,
    },
    sessionState: { token: 'dev-admin-token', profile: { id: 'admin', username: 'admin', role: 'admin' as 'admin' | 'user' } },
    workspaceState: { workspace: undefined as undefined | { id: string; provider: string; isReadOnly: boolean; capabilities: { provisioning: boolean; rangeProvisioning: boolean } } },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('../../lib/admin-api', () => ({
  AdminApiError: class AdminApiError extends Error {
    constructor(
      readonly status: number,
      message = `Admin API request failed with status ${status}`,
    ) {
      super(message);
    }
  },
  fetchRangeInstanceDetail: fetchRangeInstanceDetailMock,
  fetchInstanceTypeAvailability: fetchInstanceTypeAvailabilityMock,
  fetchPlatformImages: fetchPlatformImagesMock,
  fetchProvisionJobDetail: fetchProvisionJobDetailMock,
  saveRangeInstanceDraft: saveRangeInstanceDraftMock,
  discardRangeInstanceDraft: discardRangeInstanceDraftMock,
  applyRangeInstanceDraft: applyRangeInstanceDraftMock,
  syncRangeInstanceTemplate: syncRangeInstanceTemplateMock,
  runRangeInstanceNodeAction: runRangeInstanceNodeActionMock,
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: sessionState.token,
    profile: sessionState.profile,
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('./cloud-workspace-provider', () => ({
  useCloudWorkspace: () => workspaceState,
}));

vi.mock('./template-editor/topology-flow-canvas', () => ({
  TopologyFlowCanvas: TopologyFlowCanvasMock,
}));

import { RangeInstanceDetailScreen } from './range-instance-detail-screen';
import { AdminPageCache } from './admin-page-cache';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';

describe('RangeInstanceDetailScreen', () => {
  beforeEach(() => {
    workspaceState.workspace = undefined;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    sessionState.token = 'dev-admin-token';
    sessionState.profile = { id: 'admin', username: 'admin', role: 'admin' };
    fetchProvisionJobDetailMock.mockReset();
    fetchProvisionJobDetailMock.mockResolvedValue({ job: { id: 'job-1', jobType: 'update', status: 'succeeded' }, steps: [] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({
      cpu: 2,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [],
      warning: null,
    });
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes a retained detail on return while preserving unsaved edits and their original revision', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    const original = {
      id: 'range-1', templateId: 'template-1', status: 'running', name: '原实例名', draftRevision: 3,
      runtimeTopologyGraph: createValidTopologyGraph(),
    };
    fetchRangeInstanceDetailMock.mockResolvedValue(original);
    saveRangeInstanceDraftMock.mockReset();
    saveRangeInstanceDraftMock.mockResolvedValue({ ...original, draftRevision: 4 });
    const createPage = (route: string) => route === '/admin/ranges/range-1'
      ? <RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />
      : <p>其他页面</p>;
    const { rerender } = render(<AdminPageCache createPage={createPage} pathname="/admin/ranges/range-1">{null}</AdminPageCache>);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(await screen.findByRole('button', { name: 'checker' }));
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    rerender(<AdminPageCache createPage={createPage} pathname="/admin/users">{null}</AdminPageCache>);
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledOnce();
    fetchRangeInstanceDetailMock.mockResolvedValue({ ...original, name: '新实例名', draftRevision: 7 });
    rerender(<AdminPageCache createPage={createPage} pathname="/admin/ranges/range-1">{null}</AdminPageCache>);
    await screen.findByText('新实例名', { selector: 'strong' });
    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalledWith(
      'http://localhost:3001', 'dev-admin-token', 'range-1', expect.objectContaining({ expectedDraftRevision: 3 }),
    ));
  });

  it('keeps unsaved instance graph changes when the access token renews', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph(),
    });
    const { rerender } = render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(await screen.findByRole('button', { name: 'checker' }));
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    sessionState.token = 'renewed-token';
    rerender(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);
    await waitFor(() => expect(fetchRangeInstanceDetailMock).toHaveBeenCalledWith('http://localhost:3001', 'renewed-token', 'range-1'));
    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('4');
  });

  it('keeps draft editing available while the workspace blocks resource apply', async () => {
    workspaceState.workspace = { id: 'tencent-space', provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true, rangeProvisioning: false } };
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph() });
    applyRangeInstanceDraftMock.mockClear();
    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    const applyButton = await screen.findByRole('button', { name: '应用变更' });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(applyButton);
    expect(applyRangeInstanceDraftMock).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed'])('tracks apply through %s and refreshes the runtime snapshot', async (status) => {
    const original = {
      id: 'range-1', templateId: 'template-1', status: 'running', draftRevision: 0,
      runtimeTopologyGraph: createValidTopologyGraph(),
    };
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValueOnce(original).mockResolvedValue({
      ...original, runtimeTopologyGraph: createValidTopologyGraph('应用后的主机'),
    });
    saveRangeInstanceDraftMock.mockResolvedValue({ ...original, draftRevision: 1, draftTopologyGraph: createValidTopologyGraph() });
    const job = { id: 'job-apply', jobType: 'update', status: 'pending' };
    applyRangeInstanceDraftMock.mockResolvedValue(job);
    fetchProvisionJobDetailMock.mockResolvedValueOnce({ job, steps: [] }).mockResolvedValue({
      job: { ...job, status, errorSummary: status === 'failed' ? '容量不足，应用失败' : null }, steps: [],
    });
    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: '应用变更' }));
    await screen.findByText('实例配置变更正在应用。');
    expect((screen.getByRole('button', { name: '应用变更' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后的主机' })).toBeTruthy(), { timeout: 4000 });
    expect(fetchProvisionJobDetailMock).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button', { name: '应用变更' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(status === 'succeeded' ? '实例配置变更已应用。' : '容量不足，应用失败')).toBeTruthy();
  });

  it('pauses pending update polling while hidden and resumes it when the retained detail returns', async () => {
    const payload = {
      id: 'range-1', status: 'running', lastJobId: 'job-apply', runtimeTopologyGraph: createValidTopologyGraph(),
    };
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue(payload);
    fetchProvisionJobDetailMock.mockResolvedValue({ job: { id: 'job-apply', jobType: 'update', status: 'running' }, steps: [] });
    const createPage = (route: string) => route === '/admin/ranges/range-1'
      ? <RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />
      : <p>其他页面</p>;
    const { rerender } = render(<AdminPageCache createPage={createPage} pathname="/admin/ranges/range-1">{null}</AdminPageCache>);
    await screen.findByText('实例配置变更正在应用。');
    rerender(<AdminPageCache createPage={createPage} pathname="/admin/users">{null}</AdminPageCache>);
    await new Promise((resolve) => window.setTimeout(resolve, 2100));
    expect(fetchProvisionJobDetailMock).toHaveBeenCalledOnce();
    fetchProvisionJobDetailMock.mockResolvedValue({ job: { id: 'job-apply', jobType: 'update', status: 'succeeded' }, steps: [] });
    rerender(<AdminPageCache createPage={createPage} pathname="/admin/ranges/range-1">{null}</AdminPageCache>);
    await screen.findByText('实例配置变更已应用。');
    expect(fetchProvisionJobDetailMock).toHaveBeenCalledTimes(2);
  });

  it('renders overview, node directory, and topology tabs from the runtime snapshot', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      resourceSummary: {
        mode: 'opentofu',
        dnatEntryIds: { 'dnat-ecs-1-22': 'fwd-1' },
        snatEntryIds: { 'snat-zone-1': 'snat-1', 'snat-zone-2': 'snat-2' },
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    expect((await screen.findAllByText('实例名')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '实例详情' })).toBeTruthy();
    expect(await screen.findByRole('tablist', { name: '实例详情视图切换' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '节点目录' })).toBeTruthy();
    expect((await screen.findAllByText('ECS 1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '打开VNC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多操作' })).toBeTruthy();
    expect(screen.getAllByText('root / 暂无')).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole('tab', { name: '拓扑结构' }));
    expect(screen.getByRole('button', { name: '保存草稿' }).getAttribute('data-variant')).toBe('outline');
    expect(screen.getByRole('button', { name: '应用变更' }).getAttribute('data-variant')).toBe('outline');
    expect(screen.getByRole('button', { name: '更新编排拓扑' }).getAttribute('data-variant')).toBe('default');
    expect(screen.getByText('公网IP（DNAT IP）')).toBeTruthy();
    expect(screen.getByText('DNAT 已下发 1 条 / SNAT 已下发 2 条')).toBeTruthy();
  });

  it('opens the shared portal menu outside the scrollable directory table', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    const moreButton = await screen.findByRole('button', { name: '更多操作' });
    fireEvent.keyDown(moreButton, { key: 'Enter', code: 'Enter' });

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '二次打包镜像' })).toBeTruthy();
    expect(menu.closest('.range-instance-directory-table')).toBeNull();
  });

  it('shows linked subnet CIDRs instead of primary and auxiliary private IP lists', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [
          { id: 'switch-1', kind: 'switch', cidr: '10.0.0.0/24' },
          {
            id: 'host-2',
            kind: 'ecs',
            data: { label: 'ECS 2' },
            nics: [
              {
                id: 'host-2-nic-1',
                switchId: 'switch-1',
                privateIp: '10.0.0.20',
                secondaryIps: ['10.0.0.21'],
                securityGroupRules: [],
              },
            ],
          },
        ],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    const nodeRow = (await screen.findByText('ECS 2')).closest('.range-instance-directory-row');
    expect(nodeRow).not.toBeNull();
    expect(nodeRow?.textContent).toContain('10.0.0.0/24');
    expect(nodeRow?.textContent).not.toContain('10.0.0.20');
    expect(nodeRow?.textContent).not.toContain('10.0.0.21');
  });

  it('blocks applying an instance draft with duplicate DNAT external ports', async () => {
    saveRangeInstanceDraftMock.mockReset();
    applyRangeInstanceDraftMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [
          {
            id: 'switch-1',
            kind: 'switch',
            label: '交换机 1',
            zoneKey: 'zone-1',
            cidr: '10.0.0.0/24',
            purpose: 'dmz',
            nat: {
              snatEnabled: true,
              dnatMappings: [
                { key: 'switch-1-dnat-1', targetHostId: 'ecs-1', externalPort: 22, internalPort: 22, protocol: 'tcp' },
              ],
            },
          },
          {
            id: 'switch-2',
            kind: 'switch',
            label: '交换机 2',
            zoneKey: 'zone-2',
            cidr: '192.168.0.0/24',
            purpose: 'internal',
            nat: {
              snatEnabled: false,
              dnatMappings: [
                { key: 'switch-2-dnat-1', targetHostId: 'ecs-2', externalPort: 22, internalPort: 22, protocol: 'tcp' },
              ],
            },
          },
        ],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: '应用变更' }));

    expect(await screen.findByText(/DNAT 公网端口 22 重复/)).toBeTruthy();
    expect(saveRangeInstanceDraftMock).not.toHaveBeenCalled();
    expect(applyRangeInstanceDraftMock).not.toHaveBeenCalled();
  });

  it('renders the topology tab with the shared flow canvas and editable property panel', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [
          { id: 'router-1', kind: 'router', label: 'Router' },
          { id: 'switch-1', kind: 'switch', label: '交换机 1', cidr: '10.0.0.0/24' },
          {
            id: 'host-1',
            kind: 'ecs',
            data: { label: 'ECS 1' },
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            nics: [
              {
                id: 'host-1-nic-1',
                switchId: 'switch-1',
                privateIp: '10.0.0.10',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
          },
        ],
        edges: [
          { id: 'edge-1', fromNodeId: 'router-1', toNodeId: 'switch-1' },
          { id: 'edge-2', fromNodeId: 'switch-1', toNodeId: 'host-1' },
        ],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    const topologyButton = await screen.findByRole('tab', { name: '拓扑结构' });
    fireEvent.mouseDown(topologyButton);
    await waitFor(() => expect(screen.getByTestId('topology-flow-workbench')).toBeTruthy());
    fireEvent.click(screen.getByText('ECS 1'));
    expect(screen.getByText('基础信息')).toBeTruthy();
    expect(screen.getByText('ECS')).toBeTruthy();
    expect(screen.getByLabelText('名称')).toBeTruthy();
    expect(screen.getByLabelText('主机名')).toBeTruthy();
    expect(screen.getByLabelText('镜像名')).toBeTruthy();
    expect(screen.getByLabelText('自定义密码')).toBeTruthy();
    expect(screen.getByText('网卡配置')).toBeTruthy();
    expect(screen.getByLabelText('CPU')).toBeTruthy();
    expect(screen.getByLabelText('内存')).toBeTruthy();
    expect(screen.getByLabelText('交换机标识 1')).toBeTruthy();
    expect(screen.getByLabelText('私网 IP 1')).toBeTruthy();
    expect(screen.getByLabelText('辅助 IP 1')).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('主机名') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('镜像名') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('CPU') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('内存') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect(screen.getByLabelText('交换机标识 1').matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('私网 IP 1') as HTMLInputElement).matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('辅助 IP 1') as HTMLInputElement).matches(':disabled')).toBe(false);
  });

  it('masks runtime credentials, exposes the full value on hover, and copies the password', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
      runtimeCredentials: {
        'host-1': {
          username: 'root',
          password: 'ChangeMe123!',
        },
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('root / ******')).toBeTruthy();
    fireEvent.focus(screen.getByText('root / ******'));
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', 'root / ChangeMe123!');

    fireEvent.click(screen.getByRole('button', { name: '复制密码' }));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith('ChangeMe123!'));
    expect(screen.getByRole('button', { name: '复制密码' }).textContent).toBe('已复制');
  });

  it('prefers explicit node draft credentials over runtime credentials in the node directory', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      runtimeCredentials: {
        'host-1': {
          username: 'root',
          password: 'ChangeMe123!',
        },
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [
          {
            id: 'host-1',
            kind: 'ecs',
            account: 'draft-admin',
            password: 'DraftPass999!',
            data: { label: 'ECS 1' },
          },
        ],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('draft-admin / ******')).toBeTruthy();
    fireEvent.focus(screen.getByText('draft-admin / ******'));
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', 'draft-admin / DraftPass999!');
  });

  it('keeps local topology edits without re-fetching the detail snapshot on every render', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [
          { id: 'router-1', kind: 'router', label: 'Router' },
          { id: 'switch-1', kind: 'switch', label: '交换机 1', cidr: '10.0.0.0/24' },
          {
            id: 'host-1',
            kind: 'ecs',
            data: { label: 'ECS 1' },
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 2,
            memory: 2,
            nics: [
              {
                id: 'host-1-nic-1',
                switchId: 'switch-1',
                privateIp: '10.0.0.10',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
          },
        ],
        edges: [
          { id: 'edge-1', fromNodeId: 'router-1', toNodeId: 'switch-1' },
          { id: 'edge-2', fromNodeId: 'switch-1', toNodeId: 'host-1' },
        ],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByText('ECS 1'));
    const cpuInput = (await screen.findByLabelText('CPU')) as HTMLInputElement;
    fireEvent.change(cpuInput, { target: { value: '4' } });

    await waitFor(() => expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('4'));
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Flow resource additions, connections, and history inside the instance draft', async () => {
    const graph = createValidTopologyGraph();
    graph.edges = [graph.edges[0]!];
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      runtimeTopologyGraph: graph,
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    expect(screen.getByTestId('flow-edge-count').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'flow connect switch ecs' }));
    expect(screen.getByTestId('flow-edge-count').textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'flow add ecs' }));
    expect(screen.getByRole('button', { name: 'ECS 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'flow undo' }));
    expect(screen.queryByRole('button', { name: 'ECS 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'flow redo' }));
    expect(screen.getByRole('button', { name: 'ECS 2' })).toBeTruthy();
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(1);
  });

  it('commits Flow position history and viewport into the saved instance draft', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftRevision: 0,
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      templateModulePathSnapshot: 'infra/opentofu/modules/alicloud-enterprise-range',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      runtimeTopologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'router-1',
            kind: 'router',
            label: 'Router',
            routeRole: 'egress',
            egressType: 'internet',
            bindEip: false,
          },
          {
            id: 'switch-1',
            kind: 'switch',
            label: 'DMZ 交换机',
            zoneKey: 'dmz',
            cidr: '10.70.10.0/24',
            purpose: 'public-entry',
            nat: {
              snatEnabled: false,
              dnatMappings: [{
                key: 'dnat-entry',
                targetHostId: 'ecs-entry',
                externalPort: 22,
                internalPort: 22,
                protocol: 'tcp',
              }],
            },
          },
          {
            id: 'ecs-entry',
            kind: 'ecs',
            label: '入口 ECS',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.70.10.10',
            image: 'aliyun_linux_3_x64_20G_alibase',
            imageId: 'aliyun_linux_3_x64_20G_alibase',
            imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
            instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            nics: [{
              id: 'ecs-entry-nic-1',
              switchId: 'switch-1',
              privateIp: '10.70.10.10',
              secondaryIps: [],
              securityGroupRules: [],
            }],
          },
        ],
        edges: [
          { id: 'edge-router-switch', fromNodeId: 'router-1', toNodeId: 'switch-1' },
          { id: 'edge-switch-ecs', fromNodeId: 'switch-1', toNodeId: 'ecs-entry' },
        ],
      },
      runtimeScenarioTemplateSpec: {
        metadata: {
          name: '浏览器验证模板',
          slug: 'range-1',
          version: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: { vpcCidr: '10.70.0.0/16' },
      },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.70.0.0/16' } },
    });
    saveRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftRevision: 1,
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(await screen.findByRole('button', { name: 'flow commit positions' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow redo' }));
    fireEvent.click(screen.getByRole('button', { name: 'flow commit viewport' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(saveRangeInstanceDraftMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        expect.objectContaining({
          draftTopologyGraph: expect.objectContaining({
            viewport: { x: -80, y: 40, zoom: 1.2 },
            nodes: expect.arrayContaining([
              expect.objectContaining({
                id: 'router-1',
                position: { x: 160, y: 220 },
              }),
            ]),
          }),
        }),
      ),
    );
  });

  it('saves and applies instance draft changes without client actor fields', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftRevision: 0,
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: createValidTopologyGraph(),
      runtimeScenarioTemplateSpec: {
        metadata: {
          name: 'checker',
          slug: 'checker',
          version: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: { vpcCidr: '10.0.0.0/16' },
      },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    saveRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftRevision: 1,
      draftTopologyGraph: createValidTopologyGraph(),
    });
    discardRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'checker' } }],
        edges: [],
      },
      draftTopologyGraph: null,
      draftScenarioTemplateSpec: null,
      draftCompiledProvisionSpec: null,
      draftUpdatedBy: null,
    });
    applyRangeInstanceDraftMock.mockResolvedValue({
      id: 'job-1',
      rangeInstanceId: 'range-1',
      jobType: 'update',
      status: 'pending',
      triggeredBy: 'admin',
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '拓扑结构' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: 'checker' }));
    await waitFor(() => expect(screen.getByLabelText('CPU')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(saveRangeInstanceDraftMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        expect.objectContaining({
          draftTopologySpec: expect.any(Object),
          expectedDraftRevision: 0,
        }),
      ),
    );
    expect(applyRangeInstanceDraftMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '应用变更' }));

    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(applyRangeInstanceDraftMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        1,
      ),
    );
  });

  it('syncs the current instance draft back into the template without client actor fields', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateId: 'template-1',
      draftRevision: 0,
      sourceTemplateRevision: 12,
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: createValidTopologyGraph(),
      runtimeScenarioTemplateSpec: { metadata: { name: 'checker' }, topology: { vpcCidr: '10.0.0.0/16' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    saveRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftRevision: 1,
      sourceTemplateRevision: 12,
      draftTopologyGraph: createValidTopologyGraph(),
      draftScenarioTemplateSpec: {
        metadata: {
          name: 'checker',
          slug: 'checker',
          version: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: { vpcCidr: '10.0.0.0/16' },
      },
      draftCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    syncRangeInstanceTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '浏览器验证模板',
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: 'checker' }));
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '更新编排拓扑' }));
    expect(screen.getByRole('dialog', { name: '更新编排拓扑' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认更新模板草稿' }));

    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(syncRangeInstanceTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        1,
        12,
      ),
    );
    expect(applyRangeInstanceDraftMock).not.toHaveBeenCalled();
  });

  it('opens VNC in a new tab when the node action returns a terminal URL', async () => {
    const vncWindow = {
      close: vi.fn(),
      location: { href: '' },
      opener: window,
    } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(vncWindow);
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
    });
    runRangeInstanceNodeActionMock.mockResolvedValue({
      status: 'accepted',
      action: 'open-vnc',
      webTerminalUrl: 'https://example.test/vnc',
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    const button = await screen.findByRole('button', { name: '打开VNC' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(runRangeInstanceNodeActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        'host-1',
        'open-vnc',
        {},
      ),
    );
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(vncWindow.opener).toBeNull();
    expect(vncWindow.location.href).toBe('https://example.test/vnc');
  });

  it('opens the pack image dialog instead of immediately calling the API', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' }, hostName: 'ecs-1' }],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    const moreButton = await screen.findByRole('button', { name: '更多操作' });
    fireEvent.keyDown(moreButton, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '二次打包镜像' }));

    expect(screen.getByRole('dialog', { name: '二次打包镜像' })).toBeTruthy();
    expect(screen.getByLabelText('镜像名')).toBeTruthy();
    expect(screen.getByLabelText('默认主机名')).toBeTruthy();
    expect(screen.getByLabelText('默认密码')).toBeTruthy();
    expect(screen.getByLabelText('镜像备注')).toBeTruthy();
    expect(runRangeInstanceNodeActionMock).not.toHaveBeenCalled();
  });

  it('keeps history instances in read-only mode', async () => {
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-history',
      name: '历史实例',
      status: 'destroyed',
      createdBy: 'admin',
      templateNameSnapshot: '历史模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-history" apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('只读历史')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull();
    expect(screen.queryByRole('button', { name: '应用变更' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更新编排拓扑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关机' })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '拓扑结构' }));
    await waitFor(() => expect(screen.getByLabelText('名称')).toBeTruthy());
    expect((screen.getByLabelText('名称') as HTMLInputElement).matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('CPU').matches(':disabled')).toBe(true);
  });
  it('preserves description, placement and public-entry metadata when saving an instance draft', async () => {
    const detail = {
      id: 'range-1', name: 'Metadata fixture', status: 'running', draftRevision: 0,
      templateModulePathSnapshot: 'infra/opentofu/modules/alicloud-enterprise-range',
      runtimeTopologyGraph: createValidTopologyGraph(),
      runtimeScenarioTemplateSpec: {
        metadata: { name: 'Metadata fixture', slug: 'metadata', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu', description: 'Keep this description' },
        topology: { vpcCidr: '10.0.0.0/16', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' },
      },
      runtimeTopologySpec: { publicEntry: { protocols: [{ protocol: 'http', port: 8080 }] } },
    };
    fetchRangeInstanceDetailMock.mockReset(); fetchRangeInstanceDetailMock.mockResolvedValue(detail);
    saveRangeInstanceDraftMock.mockReset(); saveRangeInstanceDraftMock.mockResolvedValue({ ...detail, draftRevision: 1 });
    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalledTimes(1));
    const body = saveRangeInstanceDraftMock.mock.calls[0]![3];
    expect(body.draftScenarioTemplateSpec.metadata.description).toBe('Keep this description');
    expect(body.draftScenarioTemplateSpec.topology.defaultRegion).toBe('cn-hangzhou');
    expect(body.draftScenarioTemplateSpec.topology.defaultZoneId).toBe('cn-hangzhou-h');
    expect(body.draftTopologySpec.publicEntry.protocols).toEqual([{ protocol: 'http', port: 8080 }]);
  });


  it('shows DNAT address and mapped ports only on its exact runtime node', async () => {
    const graph: { schemaVersion: string; nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } = createValidTopologyGraph('入口节点');
    graph.nodes.push({ id: 'internal-switch', kind: 'switch', cidr: '172.16.50.0/24' });
    graph.nodes.push({ id: 'peer', kind: 'ecs', label: '内网节点', nics: [{ switchId: 'internal-switch', privateIp: '172.16.50.20', secondaryIps: ['172.16.50.21'] }] });
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'running', accessEntry: { publicIp: '47.1.1.1' }, runtimeTopologyGraph: graph,
      runtimeCompiledProvisionSpec: { dnatEntries: [
        { hostKey: 'host-1', protocol: 'tcp', externalPort: 2222, internalPort: 22 },
        { hostKey: 'host-1', protocol: 'udp', externalPort: 8080, internalPort: 80 },
      ] }, resourceSummary: { dnatEntryIds: { 'dnat-host-1-tcp-2222': 'fwd-1', 'dnat-host-1-udp-8080': 'fwd-2' } },
    });
    render(<RangeInstanceDetailScreen rangeId="range-1" />);
    const entry = (await screen.findByText('入口节点')).closest('tr')!;
    const peer = screen.getByText('内网节点').closest('tr')!;
    expect(entry.textContent).toContain('47.1.1.1');
    expect(entry.textContent).toContain('TCP 2222 → 22');
    expect(entry.textContent).toContain('UDP 8080 → 80');
    expect(entry.textContent).not.toContain('10.0.10.10');
    expect(peer.textContent).toContain('172.16.50.0/24');
    expect(peer.textContent).not.toContain('47.1.1.1');
    expect(peer.textContent).not.toContain('172.16.50.20');
    expect(peer.textContent).not.toContain('172.16.50.21');
  });

  it('puts the single scroll region and keyboard focus on the shared table container', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'destroyed', runtimeTopologyGraph: createValidTopologyGraph() });
    render(<RangeInstanceDetailScreen rangeId="range-1" />);
    await screen.findByText('checker');
    const scroller = screen.getByRole('region', { name: '实例节点目录，可横向滚动' });
    expect(scroller.getAttribute('data-slot')).toBe('table-container');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    const outer = scroller.closest('.range-instance-directory-table')!;
    expect(outer.getAttribute('role')).toBeNull();
    expect(outer.getAttribute('tabindex')).toBeNull();
    expect(screen.getByRole('table', { name: '实例节点目录' }).querySelectorAll('th')).toHaveLength(8);
  });

  it('does not advertise a draft-only or undeployed DNAT mapping as a public node entry', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'running', accessEntry: { publicIp: '47.1.1.1' },
      runtimeTopologyGraph: createValidTopologyGraph(), draftTopologyGraph: createValidTopologyGraph(),
      runtimeCompiledProvisionSpec: { dnatEntries: [{ hostKey: 'host-1', protocol: 'tcp', externalPort: 2222, internalPort: 22 }] },
      resourceSummary: { dnatEntryIds: {} },
    });
    render(<RangeInstanceDetailScreen rangeId="range-1" />);
    const row = (await screen.findByText('checker')).closest('tr')!;
    expect(row.textContent).toContain('10.0.10.0/24');
    expect(row.textContent).not.toContain('47.1.1.1');
    expect(row.textContent).not.toContain('2222');
  });

  it('uses a stable overview and table skeleton without visible detail-loading text', () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockReturnValue(new Promise(() => {}));
    render(<RangeInstanceDetailScreen rangeId="range-1" />);
    expect(screen.getByTestId('range-detail-skeleton').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('正在加载实例详情...')).toBeNull();
    expect(screen.getByRole('table', { name: '实例节点目录' })).toBeTruthy();
    expect(screen.getAllByTestId('table-loading-row')).toHaveLength(2);
  });

  it('restores a fresh scoped detail cache immediately without another API request', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('缓存节点') });
    const view = (visible: boolean) => <AdminScreenCacheProvider>{visible ? <RangeInstanceDetailScreen rangeId="range-1" /> : <p>其它页面</p>}</AdminScreenCacheProvider>;
    const { rerender } = render(view(true));
    await screen.findByText('缓存节点');
    rerender(view(false));
    rerender(view(true));
    expect(screen.getByText('缓存节点')).toBeTruthy();
    expect(screen.queryByTestId('range-detail-skeleton')).toBeNull();
    await waitFor(() => expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(1));
  });

  it('keeps a previous route response from replacing the new detail scope', async () => {
    let resolveOld!: (value: unknown) => void;
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ id: 'range-2', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('新范围节点') });
    const { rerender } = render(<RangeInstanceDetailScreen rangeId="range-1" />);
    rerender(<RangeInstanceDetailScreen rangeId="range-2" />);
    await screen.findByText('新范围节点');
    await act(async () => { resolveOld({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('过时节点') }); });
    expect(screen.queryByText('过时节点')).toBeNull();
    expect(screen.getByText('新范围节点')).toBeTruthy();
  });

  it('does not show a previous user scoped detail while a different account is loading', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValueOnce({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('原账号节点') })
      .mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<AdminScreenCacheProvider><RangeInstanceDetailScreen rangeId="range-1" /></AdminScreenCacheProvider>);
    await screen.findByText('原账号节点');
    sessionState.token = 'other-account-token';
    sessionState.profile = { id: 'other-account', username: 'other-account', role: 'admin' };
    rerender(<AdminScreenCacheProvider><RangeInstanceDetailScreen rangeId="range-1" /></AdminScreenCacheProvider>);
    expect(screen.queryByText('原账号节点')).toBeNull();
    expect(screen.getByTestId('range-detail-skeleton')).toBeTruthy();
  });

  it('does not reuse a previous administrator cache when the same account loses its role', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValueOnce({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('管理员节点') })
      .mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<AdminScreenCacheProvider><RangeInstanceDetailScreen rangeId="range-1" /></AdminScreenCacheProvider>);
    await screen.findByText('管理员节点');
    sessionState.profile = { ...sessionState.profile, role: 'user' };
    rerender(<AdminScreenCacheProvider><RangeInstanceDetailScreen rangeId="range-1" /></AdminScreenCacheProvider>);
    expect(screen.queryByText('管理员节点')).toBeNull();
    expect(screen.getByTestId('range-detail-skeleton')).toBeTruthy();
    await waitFor(() => expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(2));
  });

  it('offers retry after an initial error without leaving a perpetual loading skeleton', async () => {
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('恢复节点') });
    render(<AdminScreenCacheProvider><RangeInstanceDetailScreen rangeId="range-1" /></AdminScreenCacheProvider>);
    const retry = await screen.findByRole('button', { name: '重试加载' });
    expect(screen.queryByTestId('range-detail-skeleton')).toBeNull();
    fireEvent.click(retry);
    await screen.findByText('恢复节点');
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(2);
  });


  it('does not apply a delayed previous-scope save to the new runtime draft', async () => {
    let resolveSave!: (value: unknown) => void;
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValueOnce({ id: 'range-1', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('原范围节点') })
      .mockResolvedValue({ id: 'range-2', status: 'running', runtimeTopologyGraph: createValidTopologyGraph('新范围节点') });
    saveRangeInstanceDraftMock.mockReset();
    saveRangeInstanceDraftMock.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    const { rerender } = render(<RangeInstanceDetailScreen rangeId="range-1" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
    await screen.findByRole('button', { name: '原范围节点' });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalledOnce());
    rerender(<RangeInstanceDetailScreen rangeId="range-2" />);
    await screen.findByRole('button', { name: '新范围节点' });
    await act(async () => { resolveSave({ id: 'range-1', status: 'running', draftRevision: 1, draftTopologyGraph: createValidTopologyGraph('旧保存节点') }); });
    expect(screen.queryByRole('button', { name: '旧保存节点' })).toBeNull();
    expect(screen.getByRole('button', { name: '新范围节点' })).toBeTruthy();
  });

});
