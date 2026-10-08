import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError } from '../../lib/admin-api';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';
import { AdminPageCache } from './admin-page-cache';
import { ADMIN_PAGE_SIZE_STORAGE_KEY } from './admin-pagination';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

const {
  cloneRangeTemplateMock,
  fetchRangeTemplatesMock,
  createRangeTemplateMock,
  launchRangeInstanceMock,
  updateRangeTemplateMock,
  shareRangeTemplateMock,
  unshareRangeTemplateMock,
  deleteRangeTemplateMock,
  pushMock,
  replaceMock,
  routerMock,
  sessionState,
} = vi.hoisted(() => ({
  cloneRangeTemplateMock: vi.fn(),
  fetchRangeTemplatesMock: vi.fn(),
  createRangeTemplateMock: vi.fn(),
  launchRangeInstanceMock: vi.fn(),
  updateRangeTemplateMock: vi.fn(),
  shareRangeTemplateMock: vi.fn(),
  unshareRangeTemplateMock: vi.fn(),
  deleteRangeTemplateMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
  },
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
    shareRangeTemplate: shareRangeTemplateMock,
    unshareRangeTemplate: unshareRangeTemplateMock,
    deleteRangeTemplate: deleteRangeTemplateMock,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(window.location.search),
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
      status: 'published',
      revision: 3,
      slug: 'enterprise-range',
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
    {
      id: 'template-2',
      name: '办公网横向移动靶场',
      ownerUserId: 'admin-user',
      visibility: 'private',
      status: 'private',
      revision: 5,
      slug: 'office-lateral-range',
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
  ],
};

beforeEach(() => {
  fetchRangeTemplatesMock.mockReset();
  cloneRangeTemplateMock.mockReset();
  createRangeTemplateMock.mockReset();
  launchRangeInstanceMock.mockReset();
  updateRangeTemplateMock.mockReset();
  shareRangeTemplateMock.mockReset();
  unshareRangeTemplateMock.mockReset();
  deleteRangeTemplateMock.mockReset();
  pushMock.mockReset();
  replaceMock.mockReset();
  routerMock.push = pushMock;
  routerMock.replace = replaceMock;
  window.history.replaceState(null, '', '/admin/scenarios');
  sessionState.profile = {
    id: 'admin-user',
    username: 'admin',
    role: 'admin',
  };
});

afterEach(() => {
  cleanup();
});

function openTemplateActionMenu(row: HTMLElement) {
  fireEvent.keyDown(within(row).getByRole('button', { name: '更多操作' }), {
    key: 'Enter',
  });
}

function selectTemplateView(view: 'mine' | 'platform') {
  const selectedTab = screen.getByRole('tab', { selected: true });

  if (selectedTab.textContent === (view === 'mine' ? '我的拓扑' : '平台拓扑')) {
    return;
  }

  fireEvent.keyDown(selectedTab, {
    key: view === 'platform' ? 'ArrowRight' : 'ArrowLeft',
  });
}

describe('TemplatesScreen', () => {
  it('restores a fresh cached view after returning to the page', async () => {
    fetchRangeTemplatesMock.mockResolvedValue([bootstrapPayload.rangeTemplates[0]]);

    function CachedTemplatesScreen({ visible }: { visible: boolean }) {
      return (
        <AdminScreenCacheProvider>
          {visible ? <TemplatesScreen apiBaseUrl="http://localhost:3001" /> : null}
        </AdminScreenCacheProvider>
      );
    }

    const { rerender } = render(<CachedTemplatesScreen visible />);

    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(1);

    rerender(<CachedTemplatesScreen visible={false} />);
    rerender(<CachedTemplatesScreen visible />);

    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(1);
  });

  it('renders the scenario workbench as the default admin home surface', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '靶场编排', level: 1 })).toBeTruthy();
    await screen.findByText('企业攻防靶场');

    expect(screen.getByRole('tablist', { name: '筛选靶场名视图' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '平台拓扑' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的拓扑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建拓扑' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: '靶场编排状态筛选' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部编排' })).toBeNull();
    expect(screen.queryByRole('button', { name: '已发布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '私有' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: '筛选靶场名' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '筛选靶场标识' })).toBeNull();
    expect(screen.getByRole('table', { name: '靶场列表' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '靶场' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '创建人' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '靶场描述' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '拓扑概览' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy();
    expect(
      Array.from(screen.getByRole('table', { name: '靶场列表' }).querySelectorAll('col')).at(-1)?.getAttribute('style') ?? '',
    ).toContain('width: 12rem');
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
    expect(screen.queryByLabelText('靶场编排统计')).toBeNull();
    expect(screen.queryByText('已发布 1')).toBeNull();
    expect(screen.queryByText('私有 1')).toBeNull();
    expect(screen.queryByText('总节点 5')).toBeNull();
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    expect(screen.queryByText('已发布 v1.0.0')).toBeNull();

    const publishedRow = screen.getByRole('row', { name: /企业攻防靶场/ });
    expect(within(publishedRow).getByText('已发布').getAttribute('data-status')).toBe('published');

    const searchField = screen.getByRole('searchbox', { name: '筛选靶场名' });

    fireEvent.change(searchField, { target: { value: '办公网' } });

    expect(screen.queryByText('企业攻防靶场')).toBeNull();
    expect(screen.getByText('办公网横向移动靶场')).toBeTruthy();
  });

  it('keeps the current view columns around an in-table empty state', async () => {
    fetchRangeTemplatesMock.mockResolvedValue([]);

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('当前筛选条件下没有靶场')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的拓扑', selected: true })).toBeTruthy();

    const table = screen.getByRole('table', { name: '靶场列表' });
    expect(within(table).getByRole('columnheader', { name: '靶场' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '创建人' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '靶场描述' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '拓扑概览' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeTruthy();

    const stateCell = screen.getByText('当前筛选条件下没有靶场').closest('td');
    expect(stateCell?.getAttribute('colspan')).toBe('6');
    expect(stateCell?.className).toContain('h-56');
    expect(within(stateCell as HTMLElement).queryByRole('button', { name: '新建拓扑' })).toBeNull();
  });

  it('keeps table headers visible while the initial view is loading', async () => {
    fetchRangeTemplatesMock.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the first request pending so the loading frame remains observable.
        }),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('status', { name: '正在加载靶场列表' })).toBeTruthy();

    const table = screen.getByRole('table', { name: '靶场列表' });
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(within(table).getByRole('columnheader', { name: '靶场' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '创建人' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '靶场描述' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '拓扑概览' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeTruthy();
  });

  it('keeps URL-backed views lazy across mine and platform template fetches', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : [bootstrapPayload.rangeTemplates[1]],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('办公网横向移动靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(1);
    expect(fetchRangeTemplatesMock).toHaveBeenLastCalledWith('http://localhost:3001', 'dev-admin-token', 'mine');

    selectTemplateView('platform');

    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(2);
    expect(fetchRangeTemplatesMock).toHaveBeenLastCalledWith('http://localhost:3001', 'dev-admin-token', 'platform');
    expect(window.location.search).toBe('?view=platform');
  });

  it('shows a table-body skeleton before empty state when opening an unloaded platform view', async () => {
    fetchRangeTemplatesMock.mockImplementation(
      (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
        view === 'platform'
          ? new Promise(() => {
              // Keep the platform request pending after the view switch.
            })
          : Promise.resolve([bootstrapPayload.rangeTemplates[1]]),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    selectTemplateView('platform');

    expect(await screen.findByRole('tab', { name: '平台拓扑', selected: true })).toBeTruthy();
    expect(await screen.findByRole('status', { name: '正在加载靶场列表' })).toBeTruthy();
    expect(screen.queryByText('当前筛选条件下没有靶场')).toBeNull();
    expect(screen.queryByText('无法加载靶场列表')).toBeNull();
  });

  it('replaces a failed view with a table-body skeleton immediately when retrying', async () => {
    fetchRangeTemplatesMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            // Keep the retry request pending so the transient table state is observable.
          }),
      );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    const retryButton = await screen.findByRole('button', { name: '重试加载' });
    fireEvent.click(retryButton);

    expect(await screen.findByRole('status', { name: '正在加载靶场列表' })).toBeTruthy();
    expect(screen.getAllByTestId('table-loading-row')).toHaveLength(5);
    expect(screen.queryByText('无法加载靶场列表')).toBeNull();
    expect(screen.queryByText('当前筛选条件下没有靶场')).toBeNull();
  });

  it('keeps table headers and full column span when an active view fails', async () => {
    fetchRangeTemplatesMock.mockRejectedValue(new Error('network unavailable'));

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('无法加载靶场列表')).toBeTruthy();

    const table = screen.getByRole('table', { name: '靶场列表' });
    expect(within(table).getByRole('columnheader', { name: '靶场' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '创建人' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '靶场描述' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '拓扑概览' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeTruthy();
    expect(screen.getByText('无法加载靶场列表').closest('td')?.getAttribute('colspan')).toBe('6');
  });

  it('keeps low-frequency template actions inside the action menu', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');
    fireEvent.keyDown(screen.getAllByRole('button', { name: '更多操作' })[0]!, {
      key: 'Enter',
    });

    expect(screen.getByRole('menuitem', { name: '编辑信息' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除模板' })).toBeTruthy();
  });

  it('retries the active template view after a load failure', async () => {
    fetchRangeTemplatesMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(bootstrapPayload.rangeTemplates);

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '重试加载' }));

    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('table', { name: '靶场列表' }).querySelector('tbody')?.className).toContain(
      'admin-data-table-body-enter',
    );
  });

  it('keeps the selected topology view after refresh without navigating away', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    const firstRender = render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    selectTemplateView('platform');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '平台拓扑' }).getAttribute('aria-selected')).toBe('true');
      expect(window.location.search).toBe('?view=platform');
    });
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();

    firstRender.unmount();
    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('tab', { name: '平台拓扑' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(screen.queryByRole('row', { name: /办公网横向移动靶场/ })).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('splits 平台拓扑 and 我的拓扑 while keeping 发布到平台 as a list action', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('tab', { name: '平台拓扑' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的拓扑' })).toBeTruthy();

    selectTemplateView('platform');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '平台拓扑' }).getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByRole('row', { name: /办公网横向移动靶场/ })).toBeNull();
    });
    expect(screen.getByRole('row', { name: /企业攻防靶场/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建拓扑' })).toBeTruthy();

    selectTemplateView('mine');
    expect(await screen.findByText('办公网横向移动靶场')).toBeTruthy();

    const privateRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });
    openTemplateActionMenu(privateRow);
    expect(screen.getByRole('menuitem', { name: '发布到平台' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '取消发布' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '回退为私有' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '发布版本' })).toBeNull();
  });

  it('still lets admins manage templates from the 平台拓扑 view', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : [bootstrapPayload.rangeTemplates[1]],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '平台拓扑' });
    selectTemplateView('platform');
    await screen.findByText('企业攻防靶场');
    const row = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(row);

    expect(screen.getByRole('menuitem', { name: '编辑信息' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '取消发布' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '回退为私有' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除模板' })).toBeTruthy();
  });

  it('uses the server management capability for an ordinary user whose OIDC subject differs from the platform user ID', async () => {
    sessionState.profile = {
      id: 'oidc-subject-bob',
      username: 'bob',
      role: 'user',
    };
    const ownedTemplate = {
      ...bootstrapPayload.rangeTemplates[1],
      ownerUserId: 'platform-user-bob',
      createdBy: 'bob',
      canManage: true,
    };
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'mine' ? [ownedTemplate] : [],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    const row = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    expect((within(row).getByRole('button', { name: '进入编排' }) as HTMLButtonElement).disabled).toBe(false);

    openTemplateActionMenu(row);

    expect(screen.getByRole('menuitem', { name: '编辑信息' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '发布到平台' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除模板' })).toBeTruthy();
  });

  it('retains an ordinary owner in 我的拓扑 after publishing with a different OIDC subject', async () => {
    sessionState.profile = {
      id: 'oidc-subject-bob',
      username: 'bob',
      role: 'user',
    };
    const ownedTemplate = {
      ...bootstrapPayload.rangeTemplates[1],
      ownerUserId: 'platform-user-bob',
      createdBy: 'bob',
      canManage: true,
    };
    shareRangeTemplateMock.mockResolvedValue({
      ...ownedTemplate,
      visibility: 'platform',
      status: 'published',
      revision: 6,
      canManage: true,
    });
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'mine' ? [ownedTemplate] : [],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    const row = screen.getByRole('row', { name: /办公网横向移动靶场/ });
    openTemplateActionMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '发布到平台' }));

    await waitFor(() => {
      expect(shareRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-2',
        { expectedRevision: 5 },
      );
      expect(within(screen.getByRole('row', { name: /办公网横向移动靶场/ })).getByText('已发布')).toBeTruthy();
    });
  });

  it('clones published platform templates into 我的拓扑 when ordinary users click 进入编排', async () => {
    sessionState.profile = {
      id: 'user-bob',
      username: 'bob',
      role: 'user',
    };
    cloneRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      id: 'template-clone-1',
      ownerUserId: 'user-bob',
      createdBy: 'user-bob',
      visibility: 'private',
    });
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : [],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '平台拓扑' });
    selectTemplateView('platform');
    await screen.findByText('企业攻防靶场');
    const row = screen.getByRole('row', { name: /企业攻防靶场/ });
    expect((within(row).getByRole('button', { name: '进入编排' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(row).getByRole('button', { name: '进入编排' }));

    await waitFor(() => {
      expect(cloneRangeTemplateMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'template-1');
      expect(pushMock).toHaveBeenCalledWith('/admin/scenarios/template-clone-1');
    });
  });

  it('keeps the selected row in a pending state while entering an editable topology', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    const row = screen.getByRole('row', { name: /办公网横向移动靶场/ });
    const enterButton = within(row).getByRole('button', { name: '进入编排' });

    fireEvent.click(enterButton);

    expect(pushMock).toHaveBeenCalledWith('/admin/scenarios/template-2');
    expect(enterButton.disabled).toBe(true);
    expect(within(row).getByRole('button', { name: '正在进入编排...' })).toBeTruthy();
  });

  it('clears the pending editor action after returning to the retained list page', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);
    const renderPage = (pathname: string) => (
      <AdminPageCache
        createPage={(route) =>
          route === '/admin/scenarios' ? <TemplatesScreen apiBaseUrl="http://localhost:3001" /> : <div>拓扑编辑</div>
        }
        pathname={pathname}
      >
        <div>拓扑编辑</div>
      </AdminPageCache>
    );
    const { rerender } = render(renderPage('/admin/scenarios'));

    await screen.findByText('办公网横向移动靶场');
    const row = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    fireEvent.click(within(row).getByRole('button', { name: '进入编排' }));
    expect(within(row).getByRole('button', { name: '正在进入编排...' })).toBeTruthy();

    rerender(renderPage('/admin/scenarios/template-2'));
    rerender(renderPage('/admin/scenarios'));

    await waitFor(() => {
      expect(within(screen.getByRole('row', { name: /办公网横向移动靶场/ })).getByRole('button', { name: '进入编排' })).toBeTruthy();
    });
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

    await screen.findByRole('tab', { name: '平台拓扑' });
    selectTemplateView('platform');
    await screen.findByText('企业攻防靶场');
    const row = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));

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

    selectTemplateView('mine');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '我的拓扑' }).getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByRole('row', { name: /企业攻防靶场/ })).toBeNull();
    });
    expect(screen.getByRole('row', { name: /办公网横向移动靶场/ })).toBeTruthy();
  });

  it("does not render another user's unpublished platform template in 平台拓扑 for ordinary users", async () => {
    sessionState.profile = {
      id: 'user-bob',
      username: 'bob',
      role: 'user',
    };
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [] : [],
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '平台拓扑' });
    selectTemplateView('platform');
    expect(screen.queryByText('办公网横向移动靶场')).toBeNull();
  });

  it('opens a local new-template editor without calling the create API', async () => {
    fetchRangeTemplatesMock.mockResolvedValue([]);
    window.sessionStorage.clear();

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '新建拓扑' }));

    const dialog = screen.getByRole('dialog', { name: '创建靶场' });

    fireEvent.change(within(dialog).getByLabelText('靶场名'), {
      target: { value: '企业攻防靶场 V2' },
    });
    fireEvent.change(within(dialog).getByLabelText('靶场描述'), {
      target: { value: '用于综合渗透训练的企业网络靶场' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入编排' }));

    expect(createRangeTemplateMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/admin/scenarios/new');
    expect(JSON.parse(window.sessionStorage.getItem('template-editor:new-template') ?? '{}')).toMatchObject({
      name: '企业攻防靶场 V2',
      description: '用于综合渗透训练的企业网络靶场',
      draftId: expect.any(String),
    });
  });

  it('keeps edit and share actions inside the row action menu', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    updateRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      revision: 4,
    });
    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByRole('row', { name: /企业攻防靶场/ });
    openTemplateActionMenu(row);
    expect(screen.queryByRole('menuitem', { name: '发布版本' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '取消发布' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '回退为私有' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));
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
          name: '企业攻防靶场',
          description: '更新后的靶场描述',
          expectedRevision: 3,
        }),
      );
    });
    expect(screen.getByText('靶场信息已保存。')).toBeTruthy();

    const privateRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });
    openTemplateActionMenu(privateRow);
    expect(screen.getByRole('menuitem', { name: '发布到平台' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '发布版本' })).toBeNull();
  });

  it('keeps the edit dialog open while a save request is pending', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);
    let resolveUpdate: ((template: (typeof bootstrapPayload.rangeTemplates)[number]) => void) | undefined;
    updateRangeTemplateMock.mockImplementation(
      () =>
        new Promise<(typeof bootstrapPayload.rangeTemplates)[number]>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');
    openTemplateActionMenu(screen.getByRole('row', { name: /企业攻防靶场/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));

    const dialog = screen.getByRole('dialog', { name: '编辑靶场' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect((within(dialog).getByRole('button', { name: '取消编辑' }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.getByRole('dialog', { name: '编辑靶场' })).toBeTruthy();

    resolveUpdate?.(bootstrapPayload.rangeTemplates[0]!);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑靶场' })).toBeNull();
    });
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

    const row = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));

    const editDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    fireEvent.change(within(editDialog).getByLabelText('靶场描述'), {
      target: { value: '更新后的靶场描述' },
    });
    fireEvent.click(within(editDialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect(screen.getByText('靶场信息已保存。')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '新建拓扑' }));

    expect(screen.queryByText('靶场信息已保存。')).toBeNull();
  });

  it('keeps status actions out of 编辑信息 dialogs', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    openTemplateActionMenu(draftRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));

    const draftDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    expect(within(draftDialog).queryByLabelText('状态')).toBeNull();
    fireEvent.click(within(draftDialog).getByRole('button', { name: '取消编辑' }));

    const publishedRow = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(publishedRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑信息' }));

    const publishedDialog = screen.getByRole('dialog', { name: '编辑靶场' });
    expect(within(publishedDialog).queryByLabelText('状态')).toBeNull();
  });

  it('shows 回退为私有 for shared scenarios and calls the explicit unshare action', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    unshareRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[0],
      visibility: 'private',
      status: 'private',
      revision: 4,
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const publishedRow = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(publishedRow);
    expect(screen.getByRole('menuitem', { name: '回退为私有' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '发布版本' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: '回退为私有' }));

    await waitFor(() => {
      expect(unshareRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        { expectedRevision: 3 },
      );
    });

    await waitFor(() => {
      expect(within(publishedRow).getByText('私有')).toBeTruthy();
    });
    expect(screen.getByText('已回退为私有。')).toBeTruthy();
  });

  it('shows explicit dependency guidance in the delete template dialog', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模板' }));

    const dialog = screen.getByRole('dialog', { name: '删除靶场' });
    expect(
      within(dialog).getByText(/如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。/),
    ).toBeTruthy();
  });

  it('shows a conflict-specific message when template deletion is blocked by active instances', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    deleteRangeTemplateMock.mockRejectedValue(new AdminApiError(409, 'template has active instances'));

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const row = screen.getByRole('row', { name: /企业攻防靶场/ });

    openTemplateActionMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模板' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));

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
      ownerUserId: 'admin-user',
      visibility: 'private',
      status: 'private',
      revision: 1,
      slug: 'enterprise-range-copy',
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');

    const publishedRow = screen.getByRole('row', { name: /企业攻防靶场/ });
    openTemplateActionMenu(publishedRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制模板' }));

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

    const draftRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    openTemplateActionMenu(draftRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '生成实例' }));

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
          expiresAt: '2026-07-09T20:30:00.000Z',
        },
      );
    });

    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-100');
  });

  it('keeps the launch dialog open while an instance request is pending', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);
    let resolveLaunch: ((instance: { id: string; name: string; status: string; templateId: string }) => void) | undefined;
    launchRangeInstanceMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    openTemplateActionMenu(screen.getByRole('row', { name: /办公网横向移动靶场/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '生成实例' }));

    const dialog = screen.getByRole('dialog', { name: '生成实例' });
    fireEvent.change(within(dialog).getByLabelText('实例名'), {
      target: { value: '办公网横向移动靶场-待提交实例' },
    });
    fireEvent.change(within(dialog).getByLabelText('到期时间'), {
      target: { value: '2026-07-09T20:30' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认生成' }));

    await waitFor(() => {
      expect((within(dialog).getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.getByRole('dialog', { name: '生成实例' })).toBeTruthy();

    resolveLaunch?.({
      id: 'range-101',
      name: '办公网横向移动靶场 实例',
      templateId: 'template-2',
      status: 'pending_create',
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-101');
      expect(screen.queryByRole('dialog', { name: '生成实例' })).toBeNull();
    });
  });

  it('requires confirmation before deleting a template', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    openTemplateActionMenu(draftRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模板' }));

    expect(screen.getByRole('dialog', { name: '删除靶场' })).toBeTruthy();
    expect(
      screen.getByText(/如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。/),
    ).toBeTruthy();
  });

  it('keeps deletion confirmation pending until the request settles', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    let resolveDelete: (() => void) | undefined;
    deleteRangeTemplateMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');
    openTemplateActionMenu(screen.getByRole('row', { name: /办公网横向移动靶场/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模板' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));

    await waitFor(() => {
      expect((screen.getByRole('button', { name: '删除模板' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    });

    resolveDelete?.();

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '删除靶场' })).toBeNull();
    });
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

    const draftRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });

    openTemplateActionMenu(draftRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模板' }));
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }));

    await waitFor(() => {
      expect(screen.getByText('当前模板仍有关联的未销毁实例，请先销毁这些实例后再删除模板。已销毁实例历史会继续保留。')).toBeTruthy();
    });
  });

  it('publishes a private topology through the dedicated share action with its revision', async () => {
    fetchRangeTemplatesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine') =>
      view === 'platform' ? [bootstrapPayload.rangeTemplates[0]] : bootstrapPayload.rangeTemplates,
    );
    shareRangeTemplateMock.mockResolvedValue({
      ...bootstrapPayload.rangeTemplates[1],
      visibility: 'platform',
      status: 'published',
      revision: 6,
    });

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('办公网横向移动靶场');

    const draftRow = screen.getByRole('row', { name: /办公网横向移动靶场/ });
    openTemplateActionMenu(draftRow);
    fireEvent.click(screen.getByRole('menuitem', { name: '发布到平台' }));

    await waitFor(() => {
      expect(shareRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-2',
        { expectedRevision: 5 },
      );
    });
  });
});

describe('final authoring coverage: integrated template pagination', () => {
  beforeEach(() => window.localStorage.removeItem(ADMIN_PAGE_SIZE_STORAGE_KEY));
  afterEach(() => window.localStorage.removeItem(ADMIN_PAGE_SIZE_STORAGE_KEY));

  const templates = Array.from({ length: 125 }, (_, index) => ({
    ...bootstrapPayload.rangeTemplates[0],
    id: `paged-template-${index + 1}`,
    slug: `paged-template-${index + 1}`,
    name: `Audit ${index < 80 ? 'Alpha' : 'Beta'} ${String(index + 1).padStart(3, '0')}`,
  }));
  const expectSummary = (text: string) => expect(screen.getByText(text)).toBeTruthy();

  async function renderPagedTemplates() {
    fetchRangeTemplatesMock.mockResolvedValue(templates);
    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('Audit Alpha 001');
    return screen.getByRole('table', { name: '靶场列表' });
  }

  it('pages 125 rows through next, previous, jump and last-page boundaries', async () => {
    const table = await renderPagedTemplates();
    const pagination = within(screen.getByLabelText('靶场列表分页'));
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(20);
    expectSummary('显示 1–20 条，共 125 条');
    expect(pagination.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
    expectSummary('显示 21–40 条，共 125 条');
    expect(within(table).queryByText('Audit Alpha 001')).toBeNull();
    expect(within(table).getByText('Audit Alpha 021')).toBeTruthy();
    fireEvent.change(pagination.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '6' } });
    fireEvent.click(pagination.getByRole('button', { name: '跳转' }));
    expectSummary('显示 101–120 条，共 125 条');
    expect(pagination.getByRole('button', { name: '第 6 页' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
    expectSummary('显示 121–125 条，共 125 条');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(5);
    expect(pagination.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(pagination.getByRole('button', { name: '上一页' }));
    expectSummary('显示 101–120 条，共 125 条');
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(1);
  });

  it('resets pagination when changing from 20 to 100 and 50 rows', async () => {
    const table = await renderPagedTemplates();
    const pagination = within(screen.getByLabelText('靶场列表分页'));
    fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
    fireEvent.keyDown(pagination.getByRole('combobox', { name: '每页条数' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '100 条' }));
    await waitFor(() => expectSummary('显示 1–100 条，共 125 条'));
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(100);
    expect(pagination.getByRole('button', { name: '第 1 页' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
    expectSummary('显示 101–125 条，共 125 条');
    expect(within(table).getByText('Audit Beta 101')).toBeTruthy();
    fireEvent.keyDown(pagination.getByRole('combobox', { name: '每页条数' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '50 条' }));
    await waitFor(() => expectSummary('显示 1–50 条，共 125 条'));
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(50);
    expect(window.localStorage.getItem(ADMIN_PAGE_SIZE_STORAGE_KEY)).toBe('50');
    fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
    expectSummary('显示 51–100 条，共 125 条');
    expect(within(table).getByText('Audit Alpha 051')).toBeTruthy();
    expect(within(table).getByText('Audit Beta 100')).toBeTruthy();
  });

  it('resets a still-valid page after search and recovers from empty results', async () => {
    const table = await renderPagedTemplates();
    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));
    expectSummary('显示 41–60 条，共 125 条');
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选靶场名' }), { target: { value: 'Alpha' } });
    await waitFor(() => expectSummary('显示 1–20 条，共 80 条'));
    expect(screen.getByRole('button', { name: '第 1 页' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(table).getByText('Audit Alpha 001')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选靶场名' }), { target: { value: 'no matching template' } });
    expect(screen.getByText('当前筛选条件下没有靶场')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选靶场名' }), { target: { value: '' } });
    await waitFor(() => expectSummary('显示 1–20 条，共 125 条'));
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a fast jump typed when page 2 rows first become visible', async () => {
    const table = await renderPagedTemplates();
    const pagination = within(screen.getByLabelText('靶场列表分页'));
    const jumpInput = pagination.getByRole('spinbutton', { name: '跳转到页码' }) as HTMLInputElement;
    const valuesAtFirstCommit: string[] = [];
    const observer = new MutationObserver(() => {
      if (within(table).queryByText('Audit Alpha 021')) {
        valuesAtFirstCommit.push(jumpInput.value);
        observer.disconnect();
        fireEvent.change(jumpInput, { target: { value: '6' } });
      }
    });
    observer.observe(table, { childList: true, subtree: true });
    try {
      fireEvent.click(pagination.getByRole('button', { name: '下一页' }));
      await within(table).findByText('Audit Alpha 021');
      expect(jumpInput.value).toBe('6');
      expect(valuesAtFirstCommit).toEqual(['2']);
      fireEvent.click(pagination.getByRole('button', { name: '跳转' }));
      await within(table).findByText('Audit Beta 101');
      expectSummary('显示 101–120 条，共 125 条');
    } finally {
      observer.disconnect();
    }
  });
});
