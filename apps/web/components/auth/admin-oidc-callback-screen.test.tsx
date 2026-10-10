import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const fetchMock = vi.fn();
const searchParamsState = {
  value: new URLSearchParams('code=oidc-code&state=oidc-state'),
};
const storage = new Map<string, string>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParamsState.value,
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

Object.defineProperty(window, 'sessionStorage', {
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

Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    origin: 'http://localhost:3000',
  },
});

import { ADMIN_SESSION_STORAGE_KEY } from '../../lib/admin-auth-storage';
import {
  ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY,
  ADMIN_OIDC_STATE_STORAGE_KEY,
} from '../../lib/admin-oidc';
import { AdminOidcCallbackScreen } from './admin-oidc-callback-screen';

describe('AdminOidcCallbackScreen', () => {
  beforeEach(() => {
    replace.mockReset();
    fetchMock.mockReset();
    storage.clear();
    searchParamsState.value = new URLSearchParams('code=oidc-code&state=oidc-state');
    storage.set(ADMIN_OIDC_STATE_STORAGE_KEY, 'oidc-state');
    storage.set(ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY, 'oidc-code-verifier');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('exchanges the code, stores the session, and redirects to /admin/scenarios', async () => {
    const accessToken = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          sub: 'alice-subject',
          preferred_username: 'alice',
          realm_access: { roles: ['user'] },
        }),
      ).toString('base64url'),
      'signature',
    ].join('.');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: accessToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<AdminOidcCallbackScreen oidcIssuer="http://localhost:8080/realms/cyber-range" oidcClientId="platform-web" />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/admin/scenarios');
    });

    expect(screen.queryByText('正在完成登录...')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY) ?? 'null')).toEqual({
      token: accessToken,
      sessionGeneration: 0,
      profile: {
        id: 'alice-subject',
        username: 'alice',
        role: 'user',
      },
    });
  });

  it('shows an error when the callback state is missing or invalid', async () => {
    storage.delete(ADMIN_OIDC_STATE_STORAGE_KEY);

    render(<AdminOidcCallbackScreen oidcIssuer="http://localhost:8080/realms/cyber-range" oidcClientId="platform-web" />);

    await waitFor(() => {
      expect(screen.getByText('管理员登录失败，请稍后重试。')).toBeTruthy();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe('/admin/login');
  });

  it.each(['network', 'invalid-json'])('offers login recovery when token exchange fails with %s', async failure => {
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else fetchMock.mockResolvedValueOnce(new Response('invalid-json', { status: 200 }));

    render(<AdminOidcCallbackScreen oidcIssuer="http://localhost:8080/realms/cyber-range" oidcClientId="platform-web" />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('管理员登录失败，请稍后重试。'));
    expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe('/admin/login');
    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers a fresh login after the identity service rejects authentication', async () => {
    searchParamsState.value = new URLSearchParams('error=access_denied');
    render(<AdminOidcCallbackScreen oidcIssuer="http://localhost:8080/realms/cyber-range" oidcClientId="platform-web" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe('/admin/login');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not restore a cancelled login when its token response arrives late', async () => {
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolveResponse = resolve; }));
    const view = render(<AdminOidcCallbackScreen oidcIssuer="http://localhost:8080/realms/cyber-range" oidcClientId="platform-web" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    view.unmount();
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: 'old-user', preferred_username: 'old-user', realm_access: { roles: ['user'] } })).toString('base64url')}.signature`;
    resolveResponse(new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }));
    await waitFor(() => expect(storage.has(ADMIN_OIDC_STATE_STORAGE_KEY)).toBe(false));
    expect(window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
