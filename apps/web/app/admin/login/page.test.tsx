import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminSession } from '../../../components/admin/use-admin-session';
import { ADMIN_SESSION_STORAGE_KEY, writeAdminSession } from '../../../lib/admin-auth-storage';

const replace = vi.fn();
const assign = vi.fn();
const storage = new Map<string, string>();
const sessionStorageState = new Map<string, string>();
const LEGACY_ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';
const ADMIN_PROFILE = {
  id: 'admin',
  username: 'admin',
  role: 'admin' as const,
};
const ORIGINAL_NEXT_PUBLIC_OIDC_ISSUER = process.env.NEXT_PUBLIC_OIDC_ISSUER;
const ORIGINAL_NEXT_PUBLIC_OIDC_CLIENT_ID = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace,
  }),
}));

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

Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => sessionStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      sessionStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      sessionStorageState.delete(key);
    },
  },
});

Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    origin: 'http://localhost:3000',
    assign,
  },
});

import AdminLoginPage from './page';

describe('AdminLoginPage', () => {
  beforeEach(() => {
    replace.mockReset();
    assign.mockReset();
    storage.clear();
    sessionStorageState.clear();
    process.env.NEXT_PUBLIC_OIDC_ISSUER = 'http://localhost:8080/realms/cyber-range';
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = 'platform-web';
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (typeof ORIGINAL_NEXT_PUBLIC_OIDC_ISSUER === 'string') {
      process.env.NEXT_PUBLIC_OIDC_ISSUER = ORIGINAL_NEXT_PUBLIC_OIDC_ISSUER;
    } else {
      delete process.env.NEXT_PUBLIC_OIDC_ISSUER;
    }
    if (typeof ORIGINAL_NEXT_PUBLIC_OIDC_CLIENT_ID === 'string') {
      process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = ORIGINAL_NEXT_PUBLIC_OIDC_CLIENT_ID;
    } else {
      delete process.env.NEXT_PUBLIC_OIDC_CLIENT_ID;
    }
  });

  it('redirects to the Keycloak authorization endpoint with PKCE after clicking login', async () => {
    render(<AdminLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: '使用平台账号登录' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledTimes(1);
    });

    const authorizeUrl = new URL(String(assign.mock.calls[0][0]));
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      'http://localhost:8080/realms/cyber-range/protocol/openid-connect/auth',
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe('platform-web');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/admin/callback');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-state')).toBeTruthy();
    expect(window.sessionStorage.getItem('aliyun-cyber-range-admin-oidc-code-verifier')).toBeTruthy();
  });

  it('renders a single admin-only login experience without player entry copy', () => {
    render(<AdminLoginPage />);

    expect(screen.getByRole('heading', { name: '登录综合靶场平台' })).toBeTruthy();
    expect(screen.queryByText(/选手/)).toBeNull();
    expect(screen.queryByRole('link', { name: '选手入口' })).toBeNull();
    expect(screen.queryByText('阿里云企业网络型靶场编排与实例管理工作台')).toBeNull();
    expect(screen.queryByText('工作台 / 靶场编排')).toBeNull();
    expect(screen.queryByText('管理员登录')).toBeNull();
    expect(screen.queryByText('账号')).toBeNull();
    expect(screen.queryByText('密码')).toBeNull();
    expect(screen.getByRole('button', { name: '使用平台账号登录' })).toBeTruthy();
  });

  it('renders the workbench-aligned entry title with the canonical platform mark', () => {
    render(<AdminLoginPage />);

    const title = screen.getByRole('heading', { name: '登录综合靶场平台' });
    const mark = screen.getByTestId('admin-login-title-mark');

    expect(title).toBeTruthy();
    expect(mark.getAttribute('src')).toBe('/brand/platform-mark.svg');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('管理入口')).toBeTruthy();
    expect(screen.getByText('使用平台统一账号验证身份并进入管理后台。')).toBeTruthy();
    expect(screen.getByText('登录由平台统一身份认证服务保护')).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用平台账号登录' })).toBeTruthy();
    expect(screen.queryByText('使用平台统一账号登录管理后台。')).toBeNull();
  });

  it('normalizes shared admin sessions before persisting them', async () => {
    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    (result.current.login as unknown as (payload: { token: string; profile: typeof ADMIN_PROFILE }) => unknown)({
      token: '  normalized-admin-token  ',
      profile: ADMIN_PROFILE,
    });

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY) ?? 'null')).toEqual({
        token: 'normalized-admin-token',
        profile: ADMIN_PROFILE,
      });
    });
  });

  it('clears blank session tokens when shared admin storage rejects them', async () => {
    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    window.localStorage.setItem(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'existing-admin-token',
        profile: ADMIN_PROFILE,
      }),
    );

    (result.current.login as unknown as (payload: { token: string; profile: typeof ADMIN_PROFILE }) => unknown)({
      token: '   ',
      profile: ADMIN_PROFILE,
    });

    await waitFor(() => {
      expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it('clears blank persisted session tokens when restoring the admin session', async () => {
    window.localStorage.setItem(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: '   ',
        profile: ADMIN_PROFILE,
      }),
    );

    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(result.current.token).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('clears persisted sessions when the stored profile is missing', async () => {
    window.localStorage.setItem(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'persisted-admin-token',
      }),
    );

    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(result.current.token).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('uses controlled migration for legacy token-only storage by clearing it and keeping the user logged out', async () => {
    window.localStorage.setItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY, ' legacy-admin-token ');

    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(result.current.token).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(window.localStorage.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('restores the persisted admin session once the admin session is ready', async () => {
    window.localStorage.setItem(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'persisted-admin-token',
        profile: ADMIN_PROFILE,
      }),
    );

    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    expect(result.current.token).toBe('persisted-admin-token');
    expect(result.current.profile).toEqual(ADMIN_PROFILE);
    expect(result.current.isAdmin).toBe(true);
  });

  it('keeps login and logout callbacks stable across rerenders', async () => {
    const { result, rerender } = renderHook(() => useAdminSession());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    const firstLogin = result.current.login;
    const firstLogout = result.current.logout;

    rerender();

    expect(result.current.login).toBe(firstLogin);
    expect(result.current.logout).toBe(firstLogout);
  });
});
