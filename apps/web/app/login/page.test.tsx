import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LoginPage from './page';

describe('LoginPage', () => {
  it('shows the player login page and admin entry link', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: '选手登录' })).toBeTruthy();
    expect(screen.getByText('综合靶场竞赛入口')).toBeTruthy();
    expect(screen.getByRole('link', { name: '管理员入口' }).getAttribute('href')).toBe('/admin/login');
  });
});
