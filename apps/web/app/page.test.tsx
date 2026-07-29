import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect, replace, sessionState } = vi.hoisted(() => ({
  redirect: vi.fn(),
  replace: vi.fn(),
  sessionState: {
    isReady: true,
    token: null as string | null,
  },
}));

vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ replace }),
}));

vi.mock('../components/admin/use-admin-session', () => ({
  useAdminSession: () => sessionState,
}));

import HomePage from './page';

describe('HomePage', () => {
  beforeEach(() => {
    redirect.mockReset();
    replace.mockReset();
    sessionState.isReady = true;
    sessionState.token = null;
  });

  afterEach(cleanup);

  it('routes a restored admin session directly to the workspace', async () => {
    sessionState.token = 'persisted-admin-token';

    render(<HomePage />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/admin/scenarios');
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('routes visitors without a session to admin login', async () => {
    render(<HomePage />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/admin/login');
    });
  });
});
