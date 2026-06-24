import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCompetitionMock,
  updateCompetitionMock,
  deleteCompetitionMock,
  createTeamMock,
  updateTeamMock,
  deleteTeamMock,
  createRangeTemplateMock,
  updateRangeTemplateMock,
  deleteRangeTemplateMock,
  fetchAdminBootstrapMock,
  fetchCloudConfigMock,
  replaceMock,
} = vi.hoisted(() => ({
  createCompetitionMock: vi.fn(),
  updateCompetitionMock: vi.fn(),
  deleteCompetitionMock: vi.fn(),
  createTeamMock: vi.fn(),
  updateTeamMock: vi.fn(),
  deleteTeamMock: vi.fn(),
  createRangeTemplateMock: vi.fn(),
  updateRangeTemplateMock: vi.fn(),
  deleteRangeTemplateMock: vi.fn(),
  fetchAdminBootstrapMock: vi.fn(),
  fetchCloudConfigMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    createCompetition: createCompetitionMock,
    updateCompetition: updateCompetitionMock,
    deleteCompetition: deleteCompetitionMock,
    createTeam: createTeamMock,
    updateTeam: updateTeamMock,
    deleteTeam: deleteTeamMock,
    createRangeTemplate: createRangeTemplateMock,
    updateRangeTemplate: updateRangeTemplateMock,
    deleteRangeTemplate: deleteRangeTemplateMock,
    fetchAdminBootstrap: fetchAdminBootstrapMock,
    fetchCloudConfig: fetchCloudConfigMock,
  };
});

import { AdminApiError } from '../../../lib/admin-api';
import { ADMIN_TOKEN_STORAGE_KEY } from '../../../lib/admin-auth-storage';
import { SettingsScreen } from './settings-screen';
import * as adminSessionModule from '../use-admin-session';

const bootstrapPayload = {
  competitions: [{ id: 'competition-1', name: '总决赛', status: 'scheduled' }],
  teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1', contactName: '王教练' }],
  rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1', name: '企业攻防靶场' }],
  rangeInstances: [],
  provisionJobs: [],
};

const cloudConfigPayload = {
  region: 'cn-hangzhou',
  zoneId: 'cn-hangzhou-h',
  provisionerMode: 'dry-run',
  instanceTypeStrategy: 'auto',
  instanceTypePreferences: ['ecs.t6-c1m2.large'],
  imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
  instancePasswordConfigured: true,
  providerZipPathConfigured: true,
  readyForPlan: true,
  checks: [
    { key: 'image_id', label: '镜像 ID', configured: true, required: true },
    { key: 'instance_password', label: '实例密码', configured: true, required: true },
  ],
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    replaceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
    fetchCloudConfigMock.mockReset();
    createCompetitionMock.mockReset();
    updateCompetitionMock.mockReset();
    deleteCompetitionMock.mockReset();
    createTeamMock.mockReset();
    updateTeamMock.mockReset();
    deleteTeamMock.mockReset();
    createRangeTemplateMock.mockReset();
    updateRangeTemplateMock.mockReset();
    deleteRangeTemplateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders tabbed settings sections including cloud config', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('基础配置');
    expect(screen.getByRole('tab', { name: '比赛' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '云配置' })).toBeTruthy();
  });

  it('shows cloud image and plan readiness details in the cloud config tab', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '云配置' });
    fireEvent.click(screen.getByRole('tab', { name: '云配置' }));

    await screen.findByText('ubuntu_22_04_x64_20G_alibase_20260615.vhd');
    await screen.findByText('已满足');
    await screen.findByText('实例密码已配置');
  });

  it('shows a loading state instead of tab content before the admin session is ready', () => {
    const useAdminSessionSpy = vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: null,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByText('正在恢复管理员会话...')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '比赛' })).toBeNull();
    expect(fetchAdminBootstrapMock).not.toHaveBeenCalled();
    expect(fetchCloudConfigMock).not.toHaveBeenCalled();

    useAdminSessionSpy.mockRestore();
  });

  it('shows a loading state while the first settings requests are still pending', async () => {
    const bootstrapDeferred = createDeferred<typeof bootstrapPayload>();
    const cloudConfigDeferred = createDeferred<typeof cloudConfigPayload>();

    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockImplementation(() => bootstrapDeferred.promise);
    fetchCloudConfigMock.mockImplementation(() => cloudConfigDeferred.promise);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('正在加载基础配置...');
    expect(screen.queryByText('暂无比赛配置。')).toBeNull();
    expect(screen.queryByText('暂无云配置。')).toBeNull();

    bootstrapDeferred.resolve(bootstrapPayload);
    cloudConfigDeferred.resolve(cloudConfigPayload);

    await screen.findByRole('tab', { name: '比赛' });
  });

  it('keeps the full-page loading state while bootstrap is still pending even if cloud config fails first', async () => {
    const bootstrapDeferred = createDeferred<typeof bootstrapPayload>();

    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockImplementation(() => bootstrapDeferred.promise);
    fetchCloudConfigMock.mockRejectedValue(new Error('cloud config unavailable'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('正在加载基础配置...');
    expect(screen.queryByRole('tab', { name: '比赛' })).toBeNull();
    expect(screen.queryByText('暂无比赛配置。')).toBeNull();

    bootstrapDeferred.resolve(bootstrapPayload);

    await screen.findByRole('tab', { name: '比赛' });
    await screen.findByText('总决赛');
  });

  it('clears the shared admin session and redirects to login when settings bootstrap returns 401', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockRejectedValue(new AdminApiError(401));
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });

    expect(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('基础配置加载失败，请刷新页面后重试。')).toBeNull();
  });

  it('keeps bootstrap data visible when cloud config fails', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockRejectedValue(new Error('cloud config unavailable'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('基础配置');
    await screen.findByText('总决赛');
    expect(screen.queryByText('暂无比赛配置。')).toBeNull();
  });

  it('creates and updates competitions from the settings workbench', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    createCompetitionMock.mockResolvedValue({
      id: 'competition-2',
      name: '华东区域赛',
      description: '区域预选',
      status: 'draft',
    });
    updateCompetitionMock.mockResolvedValue({
      id: 'competition-1',
      name: '总决赛升级版',
      description: '年度决赛',
      status: 'active',
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '比赛' });

    fireEvent.change(screen.getByLabelText('比赛名称'), {
      target: { value: '华东区域赛' },
    });
    fireEvent.change(screen.getByLabelText('比赛描述'), {
      target: { value: '区域预选' },
    });
    fireEvent.change(screen.getByLabelText('比赛状态'), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建比赛' }));

    await screen.findByText('华东区域赛');
    expect(createCompetitionMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
      name: '华东区域赛',
      description: '区域预选',
      status: 'draft',
    });

    fireEvent.click(screen.getByRole('button', { name: '编辑比赛 总决赛' }));
    fireEvent.change(screen.getByLabelText('比赛名称'), {
      target: { value: '总决赛升级版' },
    });
    fireEvent.change(screen.getByLabelText('比赛描述'), {
      target: { value: '年度决赛' },
    });
    fireEvent.change(screen.getByLabelText('比赛状态'), {
      target: { value: 'active' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存比赛' }));

    await screen.findByText('总决赛升级版');
    expect(updateCompetitionMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'competition-1', {
      name: '总决赛升级版',
      description: '年度决赛',
      status: 'active',
    });
  });

  it('updates and deletes teams from the settings workbench', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    updateTeamMock.mockResolvedValue({
      id: 'team-1',
      name: '蓝队精英组',
      competitionId: 'competition-1',
      contactName: '王教练',
      contactEmailOrPhone: 'blue@example.com',
    });
    deleteTeamMock.mockResolvedValue(undefined);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '比赛' });
    fireEvent.click(screen.getByRole('tab', { name: '队伍' }));

    fireEvent.click(screen.getByRole('button', { name: '编辑队伍 蓝队' }));
    fireEvent.change(screen.getByLabelText('队伍名称'), {
      target: { value: '蓝队精英组' },
    });
    fireEvent.change(screen.getByLabelText('联系人'), {
      target: { value: '王教练' },
    });
    fireEvent.change(screen.getByLabelText('联系方式'), {
      target: { value: 'blue@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存队伍' }));

    await screen.findByText('蓝队精英组');
    expect(updateTeamMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'team-1', {
      competitionId: 'competition-1',
      name: '蓝队精英组',
      contactName: '王教练',
      contactEmailOrPhone: 'blue@example.com',
    });

    fireEvent.click(screen.getAllByRole('button', { name: /删除队伍/ })[0]!);

    await waitFor(() => {
      expect(screen.queryByText('蓝队精英组')).toBeNull();
    });
    expect(deleteTeamMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'team-1');
  });

  it('creates and updates templates with the default enterprise topology', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    createRangeTemplateMock.mockResolvedValue({
      id: 'template-2',
      slug: 'enterprise-range-v2',
      version: 'v2',
      name: '企业攻防靶场 V2',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    });
    updateRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      name: '企业攻防靶场',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('tab', { name: '比赛' });
    fireEvent.click(screen.getByRole('tab', { name: '模板' }));

    fireEvent.change(screen.getByLabelText('模板名称'), {
      target: { value: '企业攻防靶场 V2' },
    });
    fireEvent.change(screen.getByLabelText('模板标识'), {
      target: { value: 'enterprise-range-v2' },
    });
    fireEvent.change(screen.getByLabelText('模板版本'), {
      target: { value: 'v2' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建模板' }));

    await screen.findByText('企业攻防靶场 V2');
    expect(createRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({
        name: '企业攻防靶场 V2',
        slug: 'enterprise-range-v2',
        version: 'v2',
        topologySpec: expect.objectContaining({
          vpcCidr: '10.70.0.0/16',
          publicEntry: expect.objectContaining({
            hostKey: 'dmz-entry',
          }),
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑模板 enterprise-range' }));
    fireEvent.change(screen.getByLabelText('模板版本'), {
      target: { value: 'v1.1.0' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    await screen.findByText('v1.1.0');
    expect(updateRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        version: 'v1.1.0',
      }),
    );
  });
});
