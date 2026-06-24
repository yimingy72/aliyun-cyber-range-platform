import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import LoginPage from './page';

afterEach(() => {
  cleanup();
});

describe('LoginPage', () => {
  it('shows the player login page and admin entry link', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: '选手登录' })).toBeTruthy();
    expect(screen.getByText('综合靶场竞赛入口')).toBeTruthy();
    expect(screen.getByRole('link', { name: '管理员入口' }).getAttribute('href')).toBe('/admin/login');
  });

  it('prevents the player login form from using browser default submission', () => {
    render(<LoginPage />);

    const form = screen.getByRole('form', { name: '选手登录表单' });
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });

    fireEvent(form, submitEvent);

    expect(submitEvent.defaultPrevented).toBe(true);
  });
});
