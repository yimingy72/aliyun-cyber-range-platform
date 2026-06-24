import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const fetchMock = vi.fn();
const storage = new Map<string, string>();

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

  it('stores the admin token and redirects to /admin after a successful login', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'dev-admin-token',
          profile: { username: 'admin' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<AdminLoginPage />);

    expect(screen.queryByDisplayValue('change-me')).toBeNull();

    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'change-me' } });
    fireEvent.click(screen.getByRole('button', { name: '登录管理后台' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('aliyun-cyber-range-admin-token')).toBe('dev-admin-token');
      expect(replace).toHaveBeenCalledWith('/admin');
    });
  });

  it('shows an error and does not redirect when the response token is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          profile: { username: 'admin' },
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

    expect(window.localStorage.getItem('aliyun-cyber-range-admin-token')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows an error and does not redirect when the response token is blank', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: '   ',
          profile: { username: 'admin' },
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

    expect(window.localStorage.getItem('aliyun-cyber-range-admin-token')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
