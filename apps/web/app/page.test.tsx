import { describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect,
}));

import HomePage from './page';

describe('HomePage', () => {
  it('redirects the root route to /login', () => {
    HomePage();
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
