import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AdminPaginatedList } from './admin-paginated-list';

afterEach(cleanup);

it('makes the list scroll region keyboard reachable while keeping pagination outside it', () => {
  render(<AdminPaginatedList footer={<button>下一页</button>}><div>列表数据</div></AdminPaginatedList>);
  const region = screen.getByRole('region', { name: '列表内容，可滚动' });
  expect(region.tabIndex).toBe(0);
  expect(within(region).getByText('列表数据')).toBeTruthy();
  expect(within(region).queryByText('下一页')).toBeNull();
  expect(screen.getByRole('button', { name: '下一页' }).closest('.admin-paginated-list-footer')).toBeTruthy();
});
