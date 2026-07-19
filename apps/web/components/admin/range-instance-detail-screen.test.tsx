import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchRangeInstanceDetailMock,
  saveRangeInstanceDraftMock,
  discardRangeInstanceDraftMock,
  applyRangeInstanceDraftMock,
  syncRangeInstanceTemplateMock,
  runRangeInstanceNodeActionMock,
  writeTextMock,
  pushMock,
  replaceMock,
  routerMock,
} = vi.hoisted(() => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();

  return {
    fetchRangeInstanceDetailMock: vi.fn(),
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
  saveRangeInstanceDraft: saveRangeInstanceDraftMock,
  discardRangeInstanceDraft: discardRangeInstanceDraftMock,
  applyRangeInstanceDraft: applyRangeInstanceDraftMock,
  syncRangeInstanceTemplate: syncRangeInstanceTemplateMock,
  runRangeInstanceNodeAction: runRangeInstanceNodeActionMock,
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

import { RangeInstanceDetailScreen } from './range-instance-detail-screen';

describe('RangeInstanceDetailScreen', () => {
  beforeEach(() => {
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
    vi.restoreAllMocks();
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
    expect(screen.getByRole('button', { name: '节点目录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拓扑结构' })).toBeTruthy();
    expect((await screen.findAllByText('ECS 1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '打开VNC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多操作' })).toBeTruthy();
    expect(screen.getAllByText('root / 暂无')).toHaveLength(2);
    expect(screen.getByText('DNAT 已下发 1 条 / SNAT 已下发 2 条')).toBeTruthy();
  });

  it('opens the node more-actions menu inline like the template workbench', async () => {
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
    fireEvent.click(moreButton);

    expect(screen.getByText('二次打包镜像').closest('.template-workbench-action-menu')).not.toBeNull();
    expect(screen.getByText('ECS 1').closest('.range-instance-directory-row')?.className.includes('is-menu-open')).toBe(true);
  });

  it('lists every primary and secondary private IP for an ECS node', async () => {
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
    expect(nodeRow?.textContent).toContain('10.0.0.20');
    expect(nodeRow?.textContent).toContain('10.0.0.21');
  });

  it('renders the topology tab with the shared template canvas and property panel layout', async () => {
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

    const topologyButton = await screen.findByRole('button', { name: '拓扑结构' });
    fireEvent.click(topologyButton);
    await waitFor(() => expect(screen.getByText('拓扑画布')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByText('在线编排')).toBeTruthy();
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
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('主机名') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('镜像名') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('CPU') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('内存') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('交换机标识 1') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('私网 IP 1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('辅助 IP 1') as HTMLInputElement).disabled).toBe(false);
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
    expect(screen.getByText('root / ChangeMe123!')).toBeTruthy();

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
    expect(screen.getByText('draft-admin / DraftPass999!')).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    const cpuInput = (await screen.findByLabelText('CPU')) as HTMLInputElement;
    fireEvent.change(cpuInput, { target: { value: '4' } });

    await waitFor(() => expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('4'));
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(1);
  });

  it('saves and applies instance draft changes without client actor fields', async () => {
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
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'checker' } }],
        edges: [],
      },
      runtimeScenarioTemplateSpec: { metadata: { name: 'checker' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    saveRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'checker-updated' }, label: 'checker-updated' }],
        edges: [],
      },
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

    await screen.findByRole('button', { name: '拓扑结构' });
    fireEvent.click(screen.getByRole('button', { name: '拓扑结构' }));
    await waitFor(() => expect(screen.getByLabelText('CPU')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(saveRangeInstanceDraftMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        expect.not.objectContaining({
          draftUpdatedBy: expect.anything(),
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
      ),
    );
  });

  it('syncs the current instance draft back into the template without client actor fields', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      createdBy: 'admin',
      templateId: 'template-1',
      templateNameSnapshot: '浏览器验证模板',
      createdAt: '2026-07-06T10:00:00.000Z',
      expiresAt: '2026-07-09T12:00:00.000Z',
      accessEntry: { publicIp: '47.1.1.1' },
      nodeStatuses: {
        'host-1': 'Stopped',
      },
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'checker' }, cpu: 2, memory: 2 }],
        edges: [],
      },
      runtimeScenarioTemplateSpec: { metadata: { name: 'checker' }, topology: { vpcCidr: '10.0.0.0/16' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    saveRangeInstanceDraftMock.mockResolvedValue({
      id: 'range-1',
      name: '攻防实例-一号',
      status: 'running',
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'checker' }, cpu: 4, memory: 2 }],
        edges: [],
      },
      draftScenarioTemplateSpec: { metadata: { name: 'checker' } },
      draftCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });
    syncRangeInstanceTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '浏览器验证模板',
    });

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '拓扑结构' }));
    fireEvent.click(screen.getByRole('button', { name: /checker/ }));
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '更新编排拓扑' }));

    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(syncRangeInstanceTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
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
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('button', { name: '二次打包镜像' }));

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

    fireEvent.click(screen.getByRole('button', { name: '拓扑结构' }));
    await waitFor(() => expect(screen.getByLabelText('名称')).toBeTruthy());
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('CPU').matches(':disabled')).toBe(true);
  });
});
