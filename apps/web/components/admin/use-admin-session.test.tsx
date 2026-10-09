import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAdminSession, readAdminSession, writeAdminSession } from '@/lib/admin-auth-storage';
import { useAdminSession } from './use-admin-session';

describe('session invalidation from asynchronous requests', () => {
  beforeEach(() => { window.localStorage.clear(); clearAdminSession(); });
  afterEach(cleanup);
  it('does not invalidate a renewed session when an older request expires', async () => {
    let logout!: () => void;
    function Page() { logout = useAdminSession().logout; return null; }
    const profile = { id: 'root', username: 'admin', role: 'admin' as const };
    writeAdminSession({ token: 'old-token', profile }); render(<Page />);
    const oldRequestLogout = logout;
    await act(async () => { writeAdminSession({ token: 'new-token', profile }); });
    await act(async () => { oldRequestLogout(); });
    expect(readAdminSession()?.token).toBe('new-token');
    await act(async () => { logout(); });
    expect(readAdminSession()).toBeNull();
  });
});
