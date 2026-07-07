import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  fetchRangeInstanceDetailMock,
  saveRangeInstanceDraftMock,
  discardRangeInstanceDraftMock,
  runRangeInstanceNodeActionMock,
  pushMock,
  replaceMock,
} = vi.hoisted(() => ({
  fetchRangeInstanceDetailMock: vi.fn(),
  saveRangeInstanceDraftMock: vi.fn(),
  discardRangeInstanceDraftMock: vi.fn(),
  runRangeInstanceNodeActionMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
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
  afterEach(() => {
    cleanup();
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
    expect(screen.getByRole('button', { name: '关机' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重启' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开VNC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('saves and discards instance draft changes from the property panel', async () => {
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

    render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('button', { name: '拓扑结构' });
    fireEvent.click(screen.getByRole('button', { name: '拓扑结构' }));
    await waitFor(() => expect(screen.getByLabelText('名称')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'checker-updated' } });
    fireEvent.click(screen.getByRole('button', { name: '保存变更草稿' }));

    await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '放弃未应用修改' }));
    await waitFor(() => expect(discardRangeInstanceDraftMock).toHaveBeenCalled());
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
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
        edges: [],
      },
    });

    render(<RangeInstanceDetailScreen rangeId="range-history" apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('只读历史')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存变更草稿' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关机' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '拓扑结构' }));
    await waitFor(() => expect(screen.getByLabelText('名称')).toBeTruthy());
    expect(screen.getByLabelText('名称').getAttribute('readonly')).not.toBeNull();
  });
});
