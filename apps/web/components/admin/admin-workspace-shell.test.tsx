import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSessionPayload } from '../../lib/admin-types';

const { assignMock, replaceMock, pathnameState, sessionOverrideState, storageEventState } = vi.hoisted(() => ({
  assignMock: vi.fn(),
  replaceMock: vi.fn(),
  pathnameState: { value: '/admin/scenarios' },
  sessionOverrideState: {
    value: null as {
      token: string | null;
      idToken: string | null;
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
const oidcStorage = new Map<string, string>();
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

Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => oidcStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      oidcStorage.set(key, value);
    },
    removeItem: (key: string) => {
      oidcStorage.delete(key);
    },
  },
});

Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    origin: 'http://localhost:3000',
    assign: assignMock,
  },
});

vi.stubGlobal('fetch', fetchMock);

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('./admin-page-cache', () => ({
  AdminPageCache: ({
    children,
    pathname,
  }: {
    children: React.ReactNode;
    pathname: string;
  }) => (
    <div className="admin-content-transition" data-route={pathname} data-testid="admin-content-transition">
      {children}
    </div>
  ),
}));

vi.mock('./use-admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-admin-session')>();

  return {
    ...actual,
    useAdminSession: () => sessionOverrideState.value ?? actual.useAdminSession(),
  };
});

import {
  ADMIN_SESSION_GENERATION_STORAGE_KEY,
  ADMIN_SESSION_STORAGE_KEY,
  clearAdminSession,
  invalidateAdminSessionForLogout,
  writeAdminSession,
} from '../../lib/admin-auth-storage';
import { AdminWorkspaceShell } from './admin-workspace-shell';

function createSession(overrides?: Partial<AdminSessionPayload>): AdminSessionPayload {
  return {
    token: overrides?.token ?? createJwt(),
    idToken: overrides?.idToken,
    refreshToken: overrides?.refreshToken,
    profile: {
      id: overrides?.profile?.id ?? 'admin',
      username: overrides?.profile?.username ?? 'admin',
      role: overrides?.profile?.role ?? 'admin',
    },
  };
}

function clickLinkWithoutBrowserNavigation(link: Element, init?: MouseEventInit) {
  const preventBrowserNavigation = (event: MouseEvent) => event.preventDefault();
  document.addEventListener('click', preventBrowserNavigation);

  try {
    fireEvent.click(link, init);
  } finally {
    document.removeEventListener('click', preventBrowserNavigation);
  }
}

describe('AdminWorkspaceShell', () => {
  beforeEach(() => {
    assignMock.mockReset();
    replaceMock.mockReset();
    pathnameState.value = '/admin/scenarios';
    sessionOverrideState.value = null;
    storageEventState.broadcast = false;
    storageEventState.queue = [];
    storageEventState.scheduled = false;
    storage.clear();
    oidcStorage.clear();
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

  it('marks a different destination as pending until the pathname reaches it', async () => {
    writeAdminSession(createSession());
    const { rerender } = render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    clickLinkWithoutBrowserNavigation(screen.getByRole('link', { name: /镜像中心/i }));

    expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('aria-current')).toBe('page');

    pathnameState.value = '/admin/image-center';
    rerender(
      <AdminWorkspaceShell>
        <div>image workspace</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-busy')).toBeNull();
    });
    expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('admin-content-transition').getAttribute('data-route')).toBe('/admin/image-center');
  });

  it('does not mark the current destination as pending', async () => {
    writeAdminSession(createSession());
    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    const currentLink = screen.getByRole('link', { name: /靶场编排/i });
    clickLinkWithoutBrowserNavigation(currentLink);

    expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the compact navigation drawer open for modified clicks', async () => {
    writeAdminSession(createSession());
    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));

    const navigationDialog = await screen.findByRole('dialog');
    clickLinkWithoutBrowserNavigation(within(navigationDialog).getByRole('link', { name: /镜像中心/i }), {
      ctrlKey: true,
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(navigationDialog).getByRole('link', { name: /镜像中心/i }).getAttribute('aria-busy')).toBeNull();
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

  it('仅标记桌面拓扑创建和编辑路由为沉浸式编辑页', async () => {
    writeAdminSession(createSession());

    for (const [pathname, expected] of [
      ['/admin/scenarios/new', 'true'],
      ['/admin/scenarios/example-id', 'true'],
      ['/admin/scenarios', null],
      ['/admin/image-center', null],
    ] as const) {
      pathnameState.value = pathname;
      const { unmount } = render(
        <AdminWorkspaceShell>
          <div>workspace content</div>
        </AdminWorkspaceShell>,
      );

      await screen.findByText('workspace content');
      expect(document.querySelector('.admin-workspace')?.getAttribute('data-topology-editor')).toBe(expected);
      expect(screen.getByRole('banner')).toBeTruthy();

      unmount();
    }
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

  it('ends the Keycloak browser session when the user explicitly logs out', async () => {
    writeAdminSession(createSession({ idToken: 'id-token-hint' }));
    window.sessionStorage.setItem('aliyun-cyber-range-admin-oidc-state', 'stale-state');
    window.sessionStorage.setItem('aliyun-cyber-range-admin-oidc-code-verifier', 'stale-code-verifier');

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(window.localStorage.getItem('aliyun-cyber-range-admin-session')).toBeNull();
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-state')).toBeNull();
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-code-verifier')).toBeNull();
    expect(assignMock).toHaveBeenCalledTimes(1);

    const logoutUrl = new URL(String(assignMock.mock.calls[0][0]));
    expect(logoutUrl.origin + logoutUrl.pathname).toBe(
      'http://localhost:8080/realms/cyber-range/protocol/openid-connect/logout',
    );
    expect(logoutUrl.searchParams.get('client_id')).toBe('platform-web');
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/admin/login');
    expect(logoutUrl.searchParams.get('id_token_hint')).toBe('id-token-hint');
    expect(replaceMock).not.toHaveBeenCalled();
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
      idToken: null,
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
      idToken: null,
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

  it('keeps unsaved workspace state mounted throughout a background token renewal', async () => {
    let completeRenewal!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { completeRenewal = resolve; }));
    writeAdminSession(createSession({ refreshToken: 'refresh-token-1' }));
    const mount = vi.fn();
    function DraftEditor() {
      const [draft, setDraft] = React.useState('');
      React.useEffect(() => { mount(); }, []);
      return <input aria-label="未保存拓扑" value={draft} onChange={(event) => setDraft(event.target.value)} />;
    }
    render(<AdminWorkspaceShell><DraftEditor /></AdminWorkspaceShell>);
    fireEvent.change(await screen.findByLabelText('未保存拓扑'), { target: { value: '尚未保存的修改' } });

    act(() => {
      writeAdminSession(createSession({ token: createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }), refreshToken: 'refresh-token-1' }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect((screen.getByLabelText('未保存拓扑') as HTMLInputElement).value).toBe('尚未保存的修改');
    expect(screen.getByRole('status').textContent).toBe('正在续期管理会话');
    await act(async () => {
      completeRenewal(new Response(JSON.stringify({ access_token: createJwt(), refresh_token: 'refresh-token-2' }), { status: 200 }));
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect((screen.getByLabelText('未保存拓扑') as HTMLInputElement).value).toBe('尚未保存的修改');
    expect(mount).toHaveBeenCalledOnce();
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

  it('ends the Keycloak browser session when the user explicitly logs out', async () => {
    writeAdminSession(createSession({ idToken: 'id-token-hint' }));
    window.sessionStorage.setItem('aliyun-cyber-range-admin-oidc-state', 'stale-state');
    window.sessionStorage.setItem('aliyun-cyber-range-admin-oidc-code-verifier', 'stale-code-verifier');

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(window.localStorage.getItem('aliyun-cyber-range-admin-session')).toBeNull();
    expect(Number(window.localStorage.getItem(ADMIN_SESSION_GENERATION_STORAGE_KEY))).toBeGreaterThan(0);
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-state')).toBeNull();
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-code-verifier')).toBeNull();
    expect(assignMock).toHaveBeenCalledTimes(1);

    const logoutUrl = new URL(String(assignMock.mock.calls[0][0]));
    expect(logoutUrl.origin + logoutUrl.pathname).toBe(
      'http://localhost:8080/realms/cyber-range/protocol/openid-connect/logout',
    );
    expect(logoutUrl.searchParams.get('client_id')).toBe('platform-web');
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/admin/login');
    expect(logoutUrl.searchParams.get('id_token_hint')).toBe('id-token-hint');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not restore a refreshed session after explicit logout', async () => {
    const now = Date.now();
    const dateNowMock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let resolveRefresh: (response: Response) => void = () => undefined;

    try {
      writeAdminSession(
        createSession({
          token: createJwt({ exp: Math.floor((now + 120_000) / 1000) }),
          idToken: 'original-id-token',
          refreshToken: 'refresh-token-1',
        }),
      );
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
      );

      render(
        <AdminWorkspaceShell>
          <div>workspace content</div>
        </AdminWorkspaceShell>,
      );

      await screen.findByText('workspace content');
      const logoutButton = screen.getByRole('button', { name: '退出登录' });

      dateNowMock.mockReturnValue(now + 61_000);
      window.dispatchEvent(new Event('focus'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fireEvent.click(logoutButton);

      resolveRefresh(
        new Response(
          JSON.stringify({
            access_token: createJwt({
              exp: Math.floor((now + 3_600_000) / 1000),
              sub: 'renewed-user',
              username: 'renewed',
              role: 'user',
            }),
            id_token: 'renewed-id-token',
            refresh_token: 'refresh-token-2',
          }),
          { status: 200 },
        ),
      );

      await waitFor(() => {
        expect(screen.queryByLabelText('正在续期管理会话')).toBeNull();
      });

      expect(window.localStorage.getItem('aliyun-cyber-range-admin-session')).toBeNull();
      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(replaceMock).not.toHaveBeenCalled();
    } finally {
      dateNowMock.mockRestore();
    }
  });

  it('does not restore a refreshed session after another tab clears it', async () => {
    let resolveRefresh: (response: Response) => void = () => undefined;

    writeAdminSession(
      createSession({
        token: createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        idToken: 'original-id-token',
        refreshToken: 'refresh-token-1',
      }),
    );
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    invalidateAdminSessionForLogout();

    resolveRefresh(
      new Response(
        JSON.stringify({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: 'renewed-user',
            username: 'renewed',
            role: 'user',
          }),
          id_token: 'renewed-id-token',
          refresh_token: 'refresh-token-2',
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('正在续期管理会话')).toBeNull();
    });

    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('renewed / user')).toBeNull();
  });

  it('refreshes expiring sessions before rendering the workspace', async () => {
    writeAdminSession(
      createSession({
        token: createJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        idToken: 'original-id-token',
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
    expect(JSON.parse(window.localStorage.getItem('aliyun-cyber-range-admin-session') ?? '{}').idToken).toBe(
      'original-id-token',
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
