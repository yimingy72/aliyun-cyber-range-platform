import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSessionPayload } from '../../lib/admin-types';

const { replaceMock, pathnameState, sessionOverrideState, storageEventState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameState: { value: '/admin/scenarios' },
  sessionOverrideState: {
    value: null as {
      token: string | null;
      refreshToken: string | null;
      profile: AdminSessionPayload['profile'] | null;
      isAdmin: boolean;
      isReady: boolean;
      login: (session: AdminSessionPayload) => void;
      logout: () => void;
    } | null,
  },
  storageEventState: { broadcast: false, queue: [] as Array<{ key: string; oldValue: string | null; newValue: string | null; snapshot: Array<[string, string]> }>, scheduled: false },
}));

const storage = new Map<string, string>();
const fetchMock = vi.fn();

function createJwt(options?: { exp?: number; sub?: string; username?: string; role?: 'admin' | 'user' }) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        exp: options?.exp ?? Math.floor(Date.now() / 1000) + 3600,
        sub: options?.sub ?? 'admin',
        preferred_username: options?.username ?? 'admin',
        realm_access: { roles: [options?.role ?? 'admin'] },
      }),
    ).toString('base64url'),
    'signature',
  ].join('.');
}

function emitStorageEvent(key: string, oldValue: string | null, newValue: string | null) {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
    }),
  );
}

function replaceStorageSnapshot(snapshot: Array<[string, string]>) {
  storage.clear();

  for (const [key, value] of snapshot) {
    storage.set(key, value);
  }
}

function queueStorageEvent(key: string, oldValue: string | null, newValue: string | null) {
  if (!storageEventState.broadcast) {
    return;
  }

  storageEventState.queue.push({
    key,
    oldValue,
    newValue,
    snapshot: [...storage.entries()],
  });

  if (storageEventState.scheduled) {
    return;
  }

  storageEventState.scheduled = true;

  setTimeout(() => {
    storageEventState.scheduled = false;
    const events = storageEventState.queue.splice(0);
    const finalSnapshot = events.at(-1)?.snapshot ?? [...storage.entries()];

    const dispatchNext = (index: number) => {
      if (index >= events.length) {
        replaceStorageSnapshot(finalSnapshot);
        return;
      }

      const event = events[index];
      replaceStorageSnapshot(event.snapshot);
      emitStorageEvent(event.key, event.oldValue, event.newValue);
      setTimeout(() => {
        dispatchNext(index + 1);
      }, 0);
    };

    dispatchNext(0);
  }, 0);
}

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const oldValue = storage.get(key) ?? null;
      storage.set(key, value);
      queueStorageEvent(key, oldValue, value);
    },
    removeItem: (key: string) => {
      const oldValue = storage.get(key) ?? null;
      storage.delete(key);
      if (oldValue !== null) {
        queueStorageEvent(key, oldValue, null);
      }
    },
  },
});

vi.stubGlobal('fetch', fetchMock);

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('./use-admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-admin-session')>();

  return {
    ...actual,
    useAdminSession: () => sessionOverrideState.value ?? actual.useAdminSession(),
  };
});

import { clearAdminSession, writeAdminSession } from '../../lib/admin-auth-storage';
import { AdminWorkspaceShell } from './admin-workspace-shell';

function createSession(overrides?: Partial<AdminSessionPayload>): AdminSessionPayload {
  return {
    token: overrides?.token ?? createJwt(),
    refreshToken: overrides?.refreshToken,
    profile: {
      id: overrides?.profile?.id ?? 'admin',
      username: overrides?.profile?.username ?? 'admin',
      role: overrides?.profile?.role ?? 'admin',
    },
  };
}

describe('AdminWorkspaceShell', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pathnameState.value = '/admin/scenarios';
    sessionOverrideState.value = null;
    storageEventState.broadcast = false;
    storageEventState.queue = [];
    storageEventState.scheduled = false;
    storage.clear();
    fetchMock.mockReset();
    clearAdminSession();
    storage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens the compact navigation drawer', async () => {
    writeAdminSession(createSession());

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));

    const navigationDialog = await screen.findByRole('dialog');

    expect(within(navigationDialog).getByTestId('platform-brand-mark').className).toContain('size-6');
    expect(within(navigationDialog).getByRole('link', { name: /靶场编排/i }).getAttribute('href')).toBe(
      '/admin/scenarios',
    );
    expect(within(navigationDialog).getByRole('link', { name: /基础配置/i }).getAttribute('href')).toBe(
      '/admin/settings/cloud',
    );
  });

  it('shows the admin navigation, including 用户管理 and 账单费用, for admin sessions', async () => {
    writeAdminSession(createSession());

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');

    const sidebarBrand = screen.getByTestId('admin-sidebar-brand');

    const navigation = screen.getByRole('navigation');
    const navigationLinks = within(navigation).getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(screen.getByText('综合靶场平台')).toBeTruthy();
    expect(within(sidebarBrand).getByTestId('platform-brand-mark').getAttribute('src')).toBe('/brand/platform-mark.svg');
    expect(within(navigation).getByRole('link', { name: /镜像中心/i }).getAttribute('href')).toBe('/admin/image-center');
    expect(within(navigation).getByRole('link', { name: /实例管理/i }).getAttribute('href')).toBe('/admin/instances');
    expect(within(navigation).getByRole('link', { name: /靶场编排/i }).getAttribute('href')).toBe('/admin/scenarios');
    expect(within(navigation).getByRole('link', { name: /编排实例/i }).getAttribute('href')).toBe('/admin/ranges');
    expect(within(navigation).getByRole('link', { name: /用户管理/i }).getAttribute('href')).toBe('/admin/users');
    expect(within(navigation).getByRole('link', { name: /账单费用/i }).getAttribute('href')).toBe('/admin/billing');
    expect(within(navigation).getByRole('link', { name: /基础配置/i }).getAttribute('href')).toBe('/admin/settings/cloud');
    expect(navigationLinks).toEqual([
      '/admin/image-center',
      '/admin/instances',
      '/admin/scenarios',
      '/admin/ranges',
      '/admin/users',
      '/admin/billing',
      '/admin/settings/cloud',
    ]);
    expect(screen.getByText('admin / admin')).toBeTruthy();
    expect(screen.queryByText('运营后台')).toBeNull();

    const identity = screen.getByLabelText('当前登录用户');
    expect(identity.parentElement?.className).toContain('ml-auto');
  });

  it('hides 用户管理 for regular users and shows their identity in the topbar', async () => {
    writeAdminSession(
      createSession({
        token: 'user-token',
        profile: {
          id: 'user-alice',
          username: 'alice',
          role: 'user',
        },
      }),
    );

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');

    expect(screen.getByText('alice / user')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /用户管理/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /账单费用/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /基础配置/i })).toBeNull();
  });

  it('keeps the login route outside the workspace shell', () => {
    pathnameState.value = '/admin/login';

    render(
      <AdminWorkspaceShell>
        <div>login screen</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('综合靶场平台')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('keeps the oidc callback route outside the workspace shell', () => {
    pathnameState.value = '/admin/callback';

    render(
      <AdminWorkspaceShell>
        <div>callback screen</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.getByText('callback screen')).toBeTruthy();
    expect(screen.queryByText('综合靶场平台')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders a stable recovery skeleton while the protected session is hydrating', () => {
    sessionOverrideState.value = {
      token: null,
      refreshToken: null,
      profile: null,
      isAdmin: false,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    };

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    expect(screen.getByLabelText('正在恢复管理会话')).toBeTruthy();
    expect(screen.queryByText('workspace content')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated users on non-login routes', async () => {
    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });

  it('renders a stable renewal skeleton while an expiring valid session is refreshing', async () => {
    sessionOverrideState.value = {
      token: createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
      refreshToken: 'refresh-token-1',
      profile: {
        id: 'admin',
        username: 'admin',
        role: 'admin',
      },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    };
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByLabelText('正在续期管理会话')).toBeTruthy();
    expect(screen.queryByText('workspace content')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not redirect when another tab rewrites the stored session', async () => {
    writeAdminSession(createSession());

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    expect(replaceMock).not.toHaveBeenCalled();

    storageEventState.broadcast = true;

    writeAdminSession(
      createSession({
        token: 'user-token',
        profile: {
          id: 'user-alice',
          username: 'alice',
          role: 'user',
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('alice / user')).toBeTruthy();
    });

    expect(screen.queryByRole('link', { name: /用户管理/i })).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('refreshes expiring sessions before rendering the workspace', async () => {
    writeAdminSession(
      createSession({
        token: createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        refreshToken: 'refresh-token-1',
      }),
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: 'renewed-user',
            username: 'renewed',
            role: 'user',
          }),
          refresh_token: 'refresh-token-2',
        }),
        { status: 200 },
      ),
    );

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await screen.findByText('workspace content');

    expect(screen.getByText('renewed / user')).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
