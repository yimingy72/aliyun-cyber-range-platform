import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminContentTransition } from './admin-content-transition';

describe('AdminContentTransition', () => {
  it('keys the content surface by pathname without adding another scroll container', () => {
    const { rerender } = render(
      <AdminContentTransition pathname="/admin/instances">
        <div>实例管理</div>
      </AdminContentTransition>,
    );

    const firstSurface = screen.getByTestId('admin-content-transition');
    expect(firstSurface.className).toContain('admin-content-transition');
    expect(firstSurface.textContent).toContain('实例管理');
    expect(firstSurface.getAttribute('data-route')).toBe('/admin/instances');

    rerender(
      <AdminContentTransition pathname="/admin/scenarios">
        <div>靶场编排</div>
      </AdminContentTransition>,
    );

    expect(screen.getByTestId('admin-content-transition').getAttribute('data-route')).toBe('/admin/scenarios');
  });
});
