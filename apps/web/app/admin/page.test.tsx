import { describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect,
}));

import AdminRootPage from './page';

describe('AdminRootPage', () => {
  it('redirects /admin to /admin/scenarios', () => {
    AdminRootPage();
    expect(redirect).toHaveBeenCalledWith('/admin/scenarios');
  });
});
