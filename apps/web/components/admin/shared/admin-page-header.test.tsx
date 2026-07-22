import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AdminPageHeader } from './admin-page-header';

afterEach(cleanup);

describe('AdminPageHeader', () => {
  it('renders one page heading with its optional content', () => {
    render(
      <AdminPageHeader
        title="靶场编排"
        description="管理可复用的靶场拓扑。"
        action={<button type="button">新建靶场</button>}
      />,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('靶场编排');
    expect(screen.getByText('管理可复用的靶场拓扑。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建靶场' })).toBeTruthy();
  });

  it('omits optional description and action slots', () => {
    render(<AdminPageHeader title="镜像中心" />);

    expect(screen.queryByText('管理可复用的靶场拓扑。')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
