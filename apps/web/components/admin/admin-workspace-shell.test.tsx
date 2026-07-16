import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSessionPayload } from '../../lib/admin-types';

const { replaceMock, pathnameState, storageEventState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameState: { value: '/admin/scenarios' },
  storageEventState: { broadcast: false, queue: [] as Array<{ key: string; oldValue: string | null; newValue: string | null; snapshot: Array<[string, string]> }>, scheduled: false },
}));

const storage = new Map<string, string>();

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

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

import { clearAdminSession, writeAdminSession } from '../../lib/admin-auth-storage';
import { AdminWorkspaceShell } from './admin-workspace-shell';

function createSession(overrides?: Partial<AdminSessionPayload>): AdminSessionPayload {
  return {
    token: overrides?.token ?? 'dev-admin-token',
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
    storageEventState.broadcast = false;
    storageEventState.queue = [];
    storageEventState.scheduled = false;
    storage.clear();
    clearAdminSession();
    storage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the admin navigation, including 用户管理, for admin sessions', async () => {
    writeAdminSession(createSession());

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    await screen.findByText('workspace content');

    const navigation = screen.getByRole('navigation');
    const navigationLinks = within(navigation).getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(screen.getByText('综合靶场平台')).toBeTruthy();
    expect(within(navigation).getByRole('link', { name: /镜像中心/i }).getAttribute('href')).toBe('/admin/image-center');
    expect(within(navigation).getByRole('link', { name: /实例管理/i }).getAttribute('href')).toBe('/admin/instances');
    expect(within(navigation).getByRole('link', { name: /靶场编排/i }).getAttribute('href')).toBe('/admin/scenarios');
    expect(within(navigation).getByRole('link', { name: /编排实例/i }).getAttribute('href')).toBe('/admin/ranges');
    expect(within(navigation).getByRole('link', { name: /用户管理/i }).getAttribute('href')).toBe('/admin/users');
    expect(within(navigation).getByRole('link', { name: /基础配置/i }).getAttribute('href')).toBe('/admin/settings/cloud');
    expect(navigationLinks).toEqual([
      '/admin/image-center',
      '/admin/instances',
      '/admin/scenarios',
      '/admin/ranges',
      '/admin/users',
      '/admin/settings/cloud',
    ]);
    expect(screen.getByText('admin / admin')).toBeTruthy();
    expect(screen.queryByText('运营后台')).toBeNull();
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
});
