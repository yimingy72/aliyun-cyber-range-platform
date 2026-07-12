import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError } from '../../lib/admin-api';

const {
  cloneRangeTemplateMock,
  fetchRangeTemplatesMock,
  createRangeTemplateMock,
  launchRangeInstanceMock,
  updateRangeTemplateMock,
  publishRangeTemplateMock,
  unpublishRangeTemplateMock,
  shareRangeTemplateMock,
  unshareRangeTemplateMock,
  deleteRangeTemplateMock,
  pushMock,
  replaceMock,
  sessionState,
} = vi.hoisted(() => ({
  cloneRangeTemplateMock: vi.fn(),
  fetchRangeTemplatesMock: vi.fn(),
  createRangeTemplateMock: vi.fn(),
  launchRangeInstanceMock: vi.fn(),
  updateRangeTemplateMock: vi.fn(),
  publishRangeTemplateMock: vi.fn(),
  unpublishRangeTemplateMock: vi.fn(),
  shareRangeTemplateMock: vi.fn(),
  unshareRangeTemplateMock: vi.fn(),
  deleteRangeTemplateMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  sessionState: {
    profile: {
      id: 'admin-user',
      username: 'admin',
      role: 'admin' as const,
    },
  },
}));

vi.mock('../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api');

  return {
    ...actual,
    cloneRangeTemplate: cloneRangeTemplateMock,
    fetchRangeTemplates: fetchRangeTemplatesMock,
    createRangeTemplate: createRangeTemplateMock,
    launchRangeInstance: launchRangeInstanceMock,
    updateRangeTemplate: updateRangeTemplateMock,
    publishRangeTemplate: publishRangeTemplateMock,
    unpublishRangeTemplate: unpublishRangeTemplateMock,
    shareRangeTemplate: shareRangeTemplateMock,
    unshareRangeTemplate: unshareRangeTemplateMock,
    deleteRangeTemplate: deleteRangeTemplateMock,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    profile: sessionState.profile,
    isAdmin: sessionState.profile.role === 'admin',
    logout: vi.fn(),
  }),
}));

import { TemplatesScreen } from './templates-screen';

const bootstrapPayload = {
  competitions: [],
  teams: [],
  rangeInstances: [],
  provisionJobs: [],
  rangeTemplates: [
    {
      id: 'template-1',
      name: '企业攻防靶场',
      ownerUserId: 'admin-user',
      visibility: 'platform',
      slug: 'enterprise-range',
      version: 'v1.0.0',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      currentDraftVersionId: 'draft-1',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-1',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: {
          schemaVersion: '1.0.0',
          nodes: [{ id: 'host-1' }, { id: 'switch-1' }, { id: 'nat-1' }],
          edges: [],
        },
        topologySpec: {
          vpcCidr: '10.70.0.0/16',
          networkZones: [
            { key: 'dmz', name: 'DMZ', purpose: 'dmz', cidr: '10.70.10.0/24' },
            { key: 'office', name: 'Office', purpose: 'office', cidr: '10.70.20.0/24' },
          ],
          hosts: [
            { key: 'dmz-entry', name: 'DMZ', zoneKey: 'dmz', role: 'entry', privateIp: '10.70.10.10' },
            { key: 'office-1', name: 'Office 1', zoneKey: 'office', role: 'workstation', privateIp: '10.70.20.10' },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
      },
    },
    {
      id: 'template-2',
      name: '办公网横向移动靶场',
      ownerUserId: 'admin-user',
      visibility: 'private',
      slug: 'office-lateral-range',
      version: 'v0.9.0',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: null,
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v0.9.0',
        topologyGraph: {
          schemaVersion: '1.0.0',
          nodes: [{ id: 'host-2' }, { id: 'switch-2' }],
          edges: [],
        },
        topologySpec: {
          vpcCidr: '10.90.0.0/16',
          networkZones: [{ key: 'office', name: 'Office', purpose: 'office', cidr: '10.90.10.0/24' }],
          hosts: [{ key: 'office-client', name: 'Office Client', zoneKey: 'office', role: 'workstation', privateIp: '10.90.10.10' }],
          publicEntry: {
            hostKey: 'office-client',
            protocols: [{ protocol: 'rdp', port: 3389 }],
          },
        },
      },
      currentPublishedVersion: null,
    },
  ],
};

beforeEach(() => {
  fetchRangeTemplatesMock.mockReset();
  cloneRangeTemplateMock.mockReset();
  createRangeTemplateMock.mockReset();
  launchRangeInstanceMock.mockReset();
  updateRangeTemplateMock.mockReset();
  publishRangeTemplateMock.mockReset();
  unpublishRangeTemplateMock.mockReset();
  shareRangeTemplateMock.mockReset();
  unshareRangeTemplateMock.mockReset();
  deleteRangeTemplateMock.mockReset();
  pushMock.mockReset();
  replaceMock.mockReset();
  sessionState.profile = {
    id: 'admin-user',
    username: 'admin',
    role: 'admin',
  };
});

afterEach(() => {
  cleanup();
});

describe('TemplatesScreen', () => {
  it('renders the scenario workbench as the default admin home surface', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '靶场编排' })).toBeTruthy();
    await screen.findByText('企业攻防靶场');

    expect(screen.getByRole('button', { name: '平台拓扑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我的拓扑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建靶场' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部编排' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '已发布' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '草稿中' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '筛选靶场名' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '筛选靶场标识' })).toBeNull();
    expect(screen.getByText('靶场列表')).toBeTruthy();
    expect(screen.getByText('靶场')).toBeTruthy();
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getByText('靶场描述')).toBeTruthy();
    expect(screen.getByText('拓扑概览')).toBeTruthy();
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('操作')).toBeTruthy();
    expect(screen.queryByText('模板')).toBeNull();
    expect(screen.queryByText('状态与版本 / 操作')).toBeNull();
    expect(screen.queryByText('名称 / 标识 / 描述')).toBeNull();
    expect(screen.queryByText('区域 / 主机 / 入口')).toBeNull();
    expect(screen.queryByText('发布状态 / 草稿版本 / 模块')).toBeNull();
    expect(screen.queryByText('进入编排 / 更多操作')).toBeNull();
    expect(screen.queryByText('template-1')).toBeNull();
    expect(screen.queryByText('browser-demo-template')).toBeNull();
    expect(screen.queryByText('入口主机：')).toBeNull();
    expect(screen.queryByText('infra/opentofu/modules/alicloud-enterprise-range')).toBeNull();
    expect(screen.queryByText(/^共 \d+ 个$/)).toBeNull();
    expect(screen.queryByRole('button', { name: '编排 enterprise-range' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更多操作 enterprise-range' })).toBeNull();
    expect(screen.queryByText('当前结果')).toBeNull();
    expect(screen.queryByText('用列表管理模板资产，进入编排页后再处理拓扑和节点细节。')).toBeNull();
    expect(screen.queryByText('主操作始终是“进入编排”，其他动作收进行级操作里。')).toBeNull();
    expect(screen.queryByText('模板总数')).toBeNull();
    expect(screen.queryByText('靶场模板与拓扑编辑')).toBeNull();
    expect(screen.getByText('已发布 1')).toBeTruthy();
    expect(screen.getByText('草稿 1')).toBeTruthy();
    expect(screen.getByText('总节点 5')).toBeTruthy();
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    expect(screen.queryByText('已发布 v1.0.0')).toBeNull();

    const publishedRow = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(publishedRow).toBeTruthy();
    expect(within(publishedRow!).getByText('已发布')).toBeTruthy();
    expect(Array.from(document.querySelector('.template-workbench-column-head')?.children ?? [])).toHaveLength(6);
    expect(Array.from(publishedRow?.children ?? [])).toHaveLength(6);
    expect(screen.getByText('操作').closest('.template-workbench-column-cell')?.className).toContain('workbench-action-cell');
    expect(within(publishedRow!).getByRole('button', { name: '进入编排' }).closest('.template-workbench-actions')?.className).toContain(
      'workbench-action-cell',
    );

    const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(globalsCss).toMatch(
      /\.template-workbench-column-head\s*\{[\s\S]*grid-template-columns:\s*minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\);/m,
    );
    expect(globalsCss).toMatch(
      /\.template-workbench-row\s*\{[\s\S]*grid-template-columns:\s*minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\)\s+minmax\([^)]+\);/m,
    );

    const listTitle = screen.getByText('靶场列表');
    const searchField = screen.getByRole('textbox', { name: '筛选靶场名' });
    const shell = listTitle.closest('.template-workbench-shell');
    expect(shell).toBeTruthy();
    expect(shell?.contains(searchField)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '草稿中' }));

    expect(screen.queryByText('企业攻防靶场')).toBeNull();
    expect(screen.getByText('办公网横向移动靶场')).toBeTruthy();
  });

  it('splits 平台拓扑 and 我的拓扑 while keeping 发布版本 and 发布到平台 as separate actions', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('button', { name: '平台拓扑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我的拓扑' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '平台拓扑' }));
    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(screen.queryByText('办公网横向移动靶场')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '我的拓扑' }));
    expect(await screen.findByText('办公网横向移动靶场')).toBeTruthy();

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();
    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '发布版本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布到平台' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消发布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '回退为私有' })).toBeNull();
  });

  it('still lets admins manage templates from the 平台拓扑 view', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : [bootstrapPayload.rangeTemplates[1]],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '平台拓扑' }));
    const row = (await screen.findByText('企业攻防靶场')).closest('.template-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));

    expect(screen.getByRole('button', { name: '编辑信息' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消发布' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '回退为私有' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除模板' })).toBeTruthy();
  });

  it('lets admins edit a platform template they do not own without moving it into 我的拓扑', async () => {
    const sharedPlatformTemplate = {
      ...bootstrapPayload.rangeTemplates[0],
      ownerUserId: 'user-alice',
      createdBy: 'alice',
    };

    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [sharedPlatformTemplate] : [bootstrapPayload.rangeTemplates[1]],
    );
    updateRangeTemplateMock.mockResolvedValue({
      ...sharedPlatformTemplate,
      description: 'admin updated platform template',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '平台拓扑' }));
    const row = (await screen.findByText('企业攻防靶场')).closest('.template-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑信息' }));

    const editDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    fireEvent.change(within(editDialog).getByLabelText('靶场描述'), {
      target: { value: 'admin updated platform template' },
    });
    fireEvent.click(within(editDialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        expect.objectContaining({
          description: 'admin updated platform template',
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '我的拓扑' }));
    expect(screen.queryByText('企业攻防靶场')).toBeNull();
    expect(await screen.findByText('办公网横向移动靶场')).toBeTruthy();
  });

  it('hides the action menu for ordinary users on shared but unpublished platform templates', async () => {
    sessionState.profile = {
      id: 'user-bob',
      username: 'bob',
      role: 'user',
    };
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform'
        ? [
            {
              ...bootstrapPayload.rangeTemplates[1],
              ownerUserId: 'user-alice',
              createdBy: 'alice',
              visibility: 'platform',
            },
          ]
        : [],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '平台拓扑' }));
    const row = (await screen.findByText('办公网横向移动靶场')).closest('.template-workbench-row');
    expect(row).toBeTruthy();

    expect((within(row!).getByRole('button', { name: '进入编排' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row!).queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('creates a template from minimal metadata and jumps directly into the topology editor', async () => {
    fetchRangeTemplatesMock.mockResolvedValue([]);
    createRangeTemplateMock.mockResolvedValue({
      id: 'template-2',
      slug: 'enterprise-range-v2',
      version: 'v2',
      name: '企业攻防靶场 V2',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('button', { name: '新建靶场' });

    fireEvent.click(screen.getByRole('button', { name: '新建靶场' }));

    const dialog = screen.getByRole('dialog', { name: '创建靶场' });

    fireEvent.change(within(dialog).getByLabelText('靶场名'), {
      target: { value: '企业攻防靶场 V2' },
    });
    fireEvent.change(within(dialog).getByLabelText('靶场描述'), {
      target: { value: '用于综合渗透训练的企业网络靶场' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入编排' }));

    await waitFor(() => {
      expect(createRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({
          name: '企业攻防靶场 V2',
          description: '用于综合渗透训练的企业网络靶场',
          slug: 'v2',
          version: 'v1',
          topologySpec: expect.objectContaining({
            vpcCidr: '10.0.0.0/16',
            publicEntry: expect.objectContaining({ hostKey: 'ecs-core-1' }),
          }),
        }),
      );
    });

    expect(pushMock).toHaveBeenCalledWith('/admin/scenarios/template-2');
  });

  it('keeps edit and publish actions inside the row action menu', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    updateRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      version: 'v1.1.0',
    });
    publishRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      currentPublishedVersionId: 'published-2',
      currentPublishedVersion: { id: 'published-2', status: 'published', version: 'v1.1.0' },
      currentDraftVersion: { id: 'draft-2', status: 'draft', version: 'v1.1.0' },
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(row).toBeTruthy();
    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByText('企业攻防靶场').closest('.template-workbench-row')?.className.includes('is-menu-open')).toBe(true);
    expect(screen.queryByRole('button', { name: '发布版本' })).toBeNull();
    expect(screen.getByRole('button', { name: '取消发布' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑信息' }));
    const editDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    expect(within(editDialog).queryByLabelText('编排标识')).toBeNull();
    expect(within(editDialog).queryByLabelText('编排版本')).toBeNull();
    expect(within(editDialog).queryByText('enterprise-range 的基础信息会在这里轻量维护。')).toBeNull();
    fireEvent.change(within(editDialog).getByLabelText('靶场描述'), {
      target: { value: '更新后的靶场描述' },
    });
    fireEvent.click(within(editDialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        expect.objectContaining({
          slug: 'enterprise-range',
          version: 'v1.0.0',
          description: '更新后的靶场描述',
        }),
      );
    });
    expect(screen.getByText('靶场信息已保存。')).toBeTruthy();

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();
    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '发布版本' }));

    await waitFor(() => {
      expect(publishRangeTemplateMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'template-2');
    });
    expect(screen.getByText('靶场模板已发布。')).toBeTruthy();
  });

  it('dismisses the success banner when the user clicks another button', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    updateRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      description: '更新后的靶场描述',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑信息' }));

    const editDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    fireEvent.change(within(editDialog).getByLabelText('靶场描述'), {
      target: { value: '更新后的靶场描述' },
    });
    fireEvent.click(within(editDialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect(screen.getByText('靶场信息已保存。')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '草稿中' }));

    expect(screen.queryByText('靶场信息已保存。')).toBeNull();
  });

  it('keeps status actions out of 编辑信息 dialogs', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();

    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑信息' }));

    const draftDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    expect(within(draftDialog).queryByLabelText('状态')).toBeNull();
    fireEvent.click(within(draftDialog).getByRole('button', { name: '取消编辑' }));

    const publishedRow = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(publishedRow).toBeTruthy();

    fireEvent.click(within(publishedRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑信息' }));

    const publishedDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    expect(within(publishedDialog).queryByLabelText('状态')).toBeNull();
  });

  it('shows 取消发布 for published scenarios and calls the explicit unpublish action', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    unpublishRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      currentPublishedVersionId: null,
      currentPublishedVersion: null,
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const publishedRow = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(publishedRow).toBeTruthy();

    fireEvent.click(within(publishedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '取消发布' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发布版本' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '取消发布' }));
    expect(screen.getByRole('dialog', { name: '确认取消发布' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认取消发布' }));

    await waitFor(() => {
      expect(unpublishRangeTemplateMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'template-1');
    });

    await waitFor(() => {
      expect(within(publishedRow!).getByText('草稿')).toBeTruthy();
    });
    expect(screen.getByText('已取消发布。')).toBeTruthy();
  });

  it('shows explicit dependency guidance in the delete template dialog', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));

    const dialog = screen.getByRole('dialog', { name: '确认删除靶场' });
    expect(
      within(dialog).getByText('如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。'),
    ).toBeTruthy();
  });

  it('shows a conflict-specific message when template deletion is blocked by active instances', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    deleteRangeTemplateMock.mockRejectedValue(new AdminApiError(409, 'template has active instances'));

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前模板仍有关联的未销毁实例，请先销毁这些实例后再删除模板。已销毁实例历史会继续保留。'),
      ).toBeTruthy();
    });
    expect(screen.getByText('企业攻防靶场')).toBeTruthy();
  });

  it('copies the selected template instead of creating a default skeleton', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    cloneRangeTemplateMock.mockResolvedValue({
      id: 'template-3',
      name: '企业攻防靶场 副本',
      slug: 'enterprise-range-copy',
      version: 'v1.0.0',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const publishedRow = screen.getByText('企业攻防靶场').closest('.template-workbench-row');
    expect(publishedRow).toBeTruthy();
    fireEvent.click(within(publishedRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '复制模板' }));

    await waitFor(() => {
      expect(cloneRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
      );
    });
  });

  it('asks for instance name and expiresAt before launching', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    launchRangeInstanceMock.mockResolvedValue({
      id: 'range-100',
      name: '办公网横向移动靶场 实例',
      templateId: 'template-2',
      status: 'pending_create',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();

    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '生成实例' }));

    const dialog = screen.getByRole('dialog', { name: '生成实例' });
    expect(within(dialog).getByLabelText('实例名')).toBeTruthy();
    expect(within(dialog).getByLabelText('到期时间')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('实例名'), {
      target: { value: '办公网横向移动靶场-测试实例' },
    });
    fireEvent.change(within(dialog).getByLabelText('到期时间'), {
      target: { value: '2026-07-09T20:30' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认生成' }));

    await waitFor(() => {
      expect(launchRangeInstanceMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        {
          templateId: 'template-2',
          name: '办公网横向移动靶场-测试实例',
          expiresAt: '2026-07-09T12:30:00.000Z',
        },
      );
    });

    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-100');
  });

  it('requires confirmation before deleting a template', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();

    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));

    expect(screen.getByRole('dialog', { name: '确认删除靶场' })).toBeTruthy();
    expect(
      screen.getByText('如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。'),
    ).toBeTruthy();
  });

  it('shows a dedicated conflict message when template deletion is blocked by linked instances', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    deleteRangeTemplateMock.mockRejectedValue(
      new AdminApiError(409, 'Range template cannot be deleted while non-destroyed instances still reference it'),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();

    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(screen.getByText('当前模板仍有关联的未销毁实例，请先销毁这些实例后再删除模板。已销毁实例历史会继续保留。')).toBeTruthy();
    });
  });

  it('routes 发布到平台 through the dedicated share action instead of the version publish action', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    shareRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[1],
      visibility: 'platform',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByText('办公网横向移动靶场').closest('.template-workbench-row');
    expect(draftRow).toBeTruthy();
    fireEvent.click(within(draftRow!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '发布到平台' }));

    await waitFor(() => {
      expect(shareRangeTemplateMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'template-2');
    });
    expect(publishRangeTemplateMock).not.toHaveBeenCalled();
  });
});
