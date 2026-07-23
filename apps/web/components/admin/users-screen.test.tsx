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
  logoutMock,
} = vi.hoisted(() => ({
  fetchAdminUsersMock: vi.fn(),
  createAdminUserMock: vi.fn(),
  updateAdminUserRoleMock: vi.fn(),
  updateAdminUserStatusMock: vi.fn(),
  resetAdminUserPasswordMock: vi.fn(),
  replaceMock: vi.fn(),
  logoutMock: vi.fn(),
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
    logoutMock.mockReset();
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
      logout: logoutMock,
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

    const table = screen.getByRole('table', { name: '用户列表' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['用户名', '角色', '创建时间', '更新时间', '状态', '操作']);

    const actionsHeader = within(table).getByRole('columnheader', { name: '操作' });
    const actionsCell = within(screen.getByRole('row', { name: /operator/ })).getByRole('button', { name: '禁用用户' }).parentElement;

    expect(actionsHeader.className).not.toContain('text-right');
    expect(actionsCell?.className).toContain('justify-start');
    expect(Array.from(table.querySelectorAll('col')).at(-1)?.getAttribute('style') ?? '').toContain('width: 11rem');
  });

  it('renders an empty user list inside the shared table body', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue([]);

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('当前还没有后台用户。');

    const table = await screen.findByRole('table', { name: '用户列表' });
    expect(within(table).getByRole('columnheader', { name: '用户名' })).toBeTruthy();
    expect(within(table).getByText('当前还没有后台用户。').closest('tbody')).toBeTruthy();
  });

  it('keeps a failed initial user load inside the table and retries it', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockRejectedValueOnce(new Error('network error')).mockResolvedValue(adminUsersPayload);

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const table = await screen.findByRole('table', { name: '用户列表' });
    const retryButton = await within(table).findByRole('button', { name: '重试加载' });
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeTruthy();

    fireEvent.click(retryButton);

    expect(await within(table).findByText('operator')).toBeTruthy();
  });

  it('shows a newly created user after the initial list request failed', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockRejectedValue(new Error('network error'));
    createAdminUserMock.mockResolvedValue({
      id: 'user-2',
      username: 'range-ops',
      role: 'user',
      status: 'active',
      createdAt: '2026-07-10T03:00:00.000Z',
      updatedAt: '2026-07-10T03:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByRole('button', { name: '重试加载' });
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }));

    const dialog = screen.getByRole('dialog', { name: '创建用户' });
    fireEvent.change(within(dialog).getByLabelText('用户名'), { target: { value: 'range-ops' } });
    fireEvent.change(within(dialog).getByLabelText('初始密码'), { target: { value: 'Password123!' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认创建' }));

    await waitFor(() => {
      expect(createAdminUserMock).toHaveBeenCalled();
    });

    const table = await screen.findByRole('table', { name: '用户列表' });
    expect(await within(table).findByText('range-ops')).toBeTruthy();
    expect(within(table).queryByRole('button', { name: '重试加载' })).toBeNull();
  });

  it('retains users and exposes an in-table retry after revalidation fails', async () => {
    let rejectRevalidation: (error: Error) => void = () => undefined;

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
      logout: logoutMock,
    });
    fetchAdminUsersMock
      .mockResolvedValueOnce(adminUsersPayload)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRevalidation = reject;
          }),
      );

    const { rerender } = render(<UsersScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('operator');

    rerender(<UsersScreen apiBaseUrl="http://localhost:3002" />);

    const table = screen.getByRole('table', { name: '用户列表' });
    await waitFor(() => {
      expect(fetchAdminUsersMock).toHaveBeenCalledWith('http://localhost:3002', 'dev-admin-token');
    });
    expect(within(table).getByText('operator')).toBeTruthy();
    expect(table.getAttribute('aria-busy')).toBe('true');

    rejectRevalidation(new Error('network error'));

    expect(await within(table).findByRole('button', { name: '重试加载' })).toBeTruthy();
    expect(within(table).getByText('operator')).toBeTruthy();
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
      logout: logoutMock,
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue(adminUsersPayload);
    updateAdminUserStatusMock.mockResolvedValue({
      ...adminUsersPayload[1],
      status: 'disabled',
      updatedAt: '2026-07-10T04:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('operator')).closest('tr');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '禁用用户' }));

    await waitFor(() => {
      expect(updateAdminUserStatusMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'user-1', {
        status: 'disabled',
      });
    });

    expect(within(row!).getByText('已停用')).toBeTruthy();
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
      logout: logoutMock,
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByText('只有管理员可以访问用户管理页。')).toBeTruthy();
    expect(fetchAdminUsersMock).not.toHaveBeenCalled();
  });

  it('shows a localized message when disabling the last active admin is rejected', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue([adminUsersPayload[0]]);
    updateAdminUserStatusMock.mockRejectedValue(new Error('Cannot disable the last active admin'));

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('admin')).closest('tr');
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole('button', { name: '禁用用户' }));

    await waitFor(() => {
      expect(
        screen.getByText('至少需要保留一个可用的管理员账号，无法禁用最后一个管理员。'),
      ).toBeTruthy();
    });
  });

  it('logs the current admin out after resetting their own password', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue([adminUsersPayload[0]]);
    resetAdminUserPasswordMock.mockResolvedValue({
      ...adminUsersPayload[0],
      updatedAt: '2026-07-10T05:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('admin')).closest('tr');
    expect(row).toBeTruthy();

    fireEvent.keyDown(within(row!).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '重置密码' }));

    const dialog = screen.getByRole('dialog', { name: '重置密码' });
    fireEvent.change(within(dialog).getByLabelText('新密码'), {
      target: { value: 'NewPassword123!' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重置' }));

    await waitFor(() => {
      expect(resetAdminUserPasswordMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'admin',
        { password: 'NewPassword123!' },
      );
      expect(logoutMock).toHaveBeenCalled();
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });

  it('logs the current admin out after demoting themselves', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue([adminUsersPayload[0]]);
    updateAdminUserRoleMock.mockResolvedValue({
      ...adminUsersPayload[0],
      role: 'user',
      updatedAt: '2026-07-10T06:00:00.000Z',
    });

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('admin')).closest('tr');
    expect(row).toBeTruthy();

    fireEvent.keyDown(within(row!).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '设为普通用户' }));

    await waitFor(() => {
      expect(updateAdminUserRoleMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'admin',
        { role: 'user' },
      );
      expect(logoutMock).toHaveBeenCalled();
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });

  it('keeps status toggle inline and reserves 更多操作 for role and password actions', async () => {
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
      logout: logoutMock,
    });
    fetchAdminUsersMock.mockResolvedValue(adminUsersPayload);

    render(<UsersScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('operator')).closest('tr');
    expect(row).toBeTruthy();
    expect(within(row!).getByRole('button', { name: '禁用用户' })).toBeTruthy();

    fireEvent.keyDown(within(row!).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });

    expect(within(row!).getByRole('button', { hidden: true, name: '禁用用户' })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: '设为管理员' })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: '重置密码' })).toBeTruthy();
  });
});
