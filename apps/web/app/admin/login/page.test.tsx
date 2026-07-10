import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminSession } from '../../../components/admin/use-admin-session';

const replace = vi.fn();
const fetchMock = vi.fn();
const storage = new Map<string, string>();
const ADMIN_SESSION_STORAGE_KEY = 'aliyun-cyber-range-admin-session';
const ADMIN_PROFILE = {
  id: 'admin',
  username: 'admin',
  role: 'admin' as const,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace,
  }),
}));

vi.stubGlobal('fetch', fetchMock);

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

import AdminLoginPage from './page';

describe('AdminLoginPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    replace.mockReset();
    storage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('stores the admin token and redirects to /admin/scenarios after a successful login', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: '  dev-admin-token  ',
          profile: ADMIN_PROFILE,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<AdminLoginPage />);

    expect(screen.queryByDisplayValue('change-me')).toBeNull();
    expect(screen.queryByText('选手入口')).toBeNull();

    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'change-me' } });
    fireEvent.click(screen.getByRole('button', { name: '登录管理后台' }));

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY) ?? 'null')).toEqual({
        token: 'dev-admin-token',
        profile: ADMIN_PROFILE,
      });
      expect(replace).toHaveBeenCalledWith('/admin/scenarios');
    });
  });

  it('renders a single admin-only login experience without player entry copy', () => {
    render(<AdminLoginPage />);

    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeTruthy();
    expect(screen.queryByText(/选手/)).toBeNull();
    expect(screen.queryByRole('link', { name: '选手入口' })).toBeNull();
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

  it('shows an error and does not redirect when the response token is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          profile: ADMIN_PROFILE,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<AdminLoginPage />);

    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'change-me' } });
    fireEvent.click(screen.getByRole('button', { name: '登录管理后台' }));

    await waitFor(() => {
      expect(screen.getByText('管理员登录失败，服务返回了无效会话。')).toBeTruthy();
    });

    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows an error and does not redirect when the response token is blank', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: '   ',
          profile: ADMIN_PROFILE,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<AdminLoginPage />);

    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'change-me' } });
    fireEvent.click(screen.getByRole('button', { name: '登录管理后台' }));

    await waitFor(() => {
      expect(screen.getByText('管理员登录失败，服务返回了无效会话。')).toBeTruthy();
    });

    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
