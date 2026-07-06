import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replaceMock, pathnameState, sessionState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameState: { value: '/admin/scenarios' },
  sessionState: {
    value: {
      token: 'dev-admin-token' as string | null,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    },
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => sessionState.value,
}));

import { AdminWorkspaceShell } from './admin-workspace-shell';

describe('AdminWorkspaceShell', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pathnameState.value = '/admin/scenarios';
    sessionState.value = {
      token: 'dev-admin-token',
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the four core navigation items and removes the legacy ones', () => {
    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.getByText('综合靶场平台')).toBeTruthy();
    expect(screen.queryByText('运营后台')).toBeNull();
    expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('href')).toBe('/admin/scenarios');
    expect(screen.getByRole('link', { name: /靶场实例/i }).getAttribute('href')).toBe('/admin/ranges');
    expect(screen.getByText('镜像中心')).toBeTruthy();
    expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('href')).toBe('/admin/image-center');
    expect(screen.getByRole('link', { name: /基础配置/i }).getAttribute('href')).toBe('/admin/settings/cloud');
    expect(screen.getAllByRole('link').map((item) => item.textContent?.trim())).toEqual([
      '编排靶场编排',
      '实例靶场实例',
      '镜像镜像中心',
      '配置基础配置',
    ]);
    expect(screen.queryByText('靶场总览')).toBeNull();
    expect(screen.queryByText('编排任务')).toBeNull();
  });

  it('keeps non-scenario pages on the same compact topbar without the old product eyebrow', () => {
    pathnameState.value = '/admin/ranges';

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.queryByText('云上综合靶场平台')).toBeNull();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
    expect(screen.queryByTestId('admin-scroll-rail')).toBeNull();
  });

  it('keeps the login route outside the workspace shell', () => {
    pathnameState.value = '/admin/login';
    sessionState.value = {
      token: null,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    };

    render(
      <AdminWorkspaceShell>
        <div>login screen</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('云上综合靶场平台')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated users on non-login routes', async () => {
    sessionState.value = {
      token: null,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    };

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });

  it('does not redirect while the admin session is still restoring on a protected route', async () => {
    sessionState.value = {
      token: null,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    };

    const { container, rerender } = render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    expect(container.firstChild).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();

    sessionState.value = {
      token: 'dev-admin-token',
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    };

    rerender(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(screen.getByText('workspace content')).toBeTruthy();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
