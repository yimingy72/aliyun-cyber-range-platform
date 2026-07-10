import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchAdminUsersMock,
  createAdminUserMock,
  updateAdminUserRoleMock,
  updateAdminUserStatusMock,
  resetAdminUserPasswordMock,
  replaceMock,
} = vi.hoisted(() => ({
  fetchAdminUsersMock: vi.fn(),
  createAdminUserMock: vi.fn(),
  updateAdminUserRoleMock: vi.fn(),
  updateAdminUserStatusMock: vi.fn(),
  resetAdminUserPasswordMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api');

  return {
    ...actual,
    fetchAdminUsers: fetchAdminUsersMock,
    createAdminUser: createAdminUserMock,
    updateAdminUserRole: updateAdminUserRoleMock,
    updateAdminUserStatus: updateAdminUserStatusMock,
    resetAdminUserPassword: resetAdminUserPasswordMock,
  };
});

import * as adminSessionModule from './use-admin-session';
import { UsersScreen } from './users-screen';

const adminUsersPayload = [
  {
    id: 'admin',
    username: 'admin',
    role: 'admin' as const,
    status: 'active' as const,
    createdAt: '2026-07-08T09:00:00.000Z',
    updatedAt: '2026-07-08T09:00:00.000Z',
  },
  {
    id: 'user-1',
    username: 'operator',
    role: 'user' as const,
    status: 'active' as const,
    createdAt: '2026-07-08T10:00:00.000Z',
    updatedAt: '2026-07-08T10:00:00.000Z',
  },
];

describe('UsersScreen', () => {
  beforeEach(() => {
    fetchAdminUsersMock.mockReset();
    createAdminUserMock.mockReset();
    updateAdminUserRoleMock.mockReset();
    updateAdminUserStatusMock.mockReset();
    resetAdminUserPasswordMock.mockReset();
    replaceMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads the user list for admins', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: {
        id: 'admin',
        username: 'admin',
        role: 'admin',
      },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchAdminUsersMock.mockResolvedValue(adminUsersPayload);

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    expect((await screen.findAllByRole('heading', { name: '用户管理' })).length).toBeGreaterThan(0);
    await screen.findByText('operator');

    expect(fetchAdminUsersMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(screen.getByText('用户名')).toBeTruthy();
    expect(screen.getByText('角色')).toBeTruthy();
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('更新时间')).toBeTruthy();
    expect(screen.getAllByText('管理员').length).toBeGreaterThan(0);
    expect(screen.getByText('普通用户')).toBeTruthy();
    expect(screen.getAllByText('已启用').length).toBeGreaterThan(0);
  });

  it('creates a user from the create dialog', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: {
        id: 'admin',
        username: 'admin',
        role: 'admin',
      },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchAdminUsersMock.mockResolvedValue([]);
    createAdminUserMock.mockResolvedValue({
      id: 'user-2',
      username: 'range-ops',
      role: 'user',
      status: 'active',
      createdAt: '2026-07-10T03:00:00.000Z',
      updatedAt: '2026-07-10T03:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('button', { name: '创建用户' });
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }));

    const dialog = screen.getByRole('dialog', { name: '创建用户' });
    fireEvent.change(within(dialog).getByLabelText('用户名'), {
      target: { value: 'range-ops' },
    });
    fireEvent.change(within(dialog).getByLabelText('初始密码'), {
      target: { value: ' Password123! ' },
    });
    fireEvent.change(within(dialog).getByLabelText('角色'), {
      target: { value: 'user' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认创建' }));

    await waitFor(() => {
      expect(createAdminUserMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        username: 'range-ops',
        password: ' Password123! ',
        role: 'user',
      });
    });

    expect(screen.getByText('range-ops')).toBeTruthy();
    expect(screen.getByText('用户 range-ops 已创建。')).toBeTruthy();
  });

  it('disables a user and updates the rendered status', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: {
        id: 'admin',
        username: 'admin',
        role: 'admin',
      },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchAdminUsersMock.mockResolvedValue(adminUsersPayload);
    updateAdminUserStatusMock.mockResolvedValue({
      ...adminUsersPayload[1],
      status: 'disabled',
      updatedAt: '2026-07-10T04:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('operator')).closest('.users-workbench-row');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '更多操作' }));
    fireEvent.click(within(row!).getByRole('button', { name: '禁用用户' }));

    await waitFor(() => {
      expect(updateAdminUserStatusMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'user-1', {
        status: 'disabled',
      });
    });

    expect(within(row!).getByText('已禁用')).toBeTruthy();
  });

  it('shows a permission state for non-admin sessions without loading users', () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-user-token',
      profile: {
        id: 'user-2',
        username: 'range-ops',
        role: 'user',
      },
      isAdmin: false,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByText('只有管理员可以访问用户管理页。')).toBeTruthy();
    expect(fetchAdminUsersMock).not.toHaveBeenCalled();
  });
});
