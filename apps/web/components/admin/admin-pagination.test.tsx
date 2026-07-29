import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdminPaginationControls, buildVisiblePages, getPagination } from './admin-pagination';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

describe('admin pagination helpers', () => {
  it('clamps page numbers and returns the correct slice indexes and displayed range', () => {
    expect(getPagination(101, 99, 20)).toEqual({
      totalItems: 101,
      page: 6,
      totalPages: 6,
      startIndex: 100,
      endIndex: 120,
      itemStart: 101,
      itemEnd: 101,
    });
  });

  it('keeps boundary page buttons and inserts ellipses for distant pages', () => {
    expect(buildVisiblePages(10, 5)).toEqual([1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 10]);
    expect(buildVisiblePages(2, 1)).toEqual([1, 2]);
  });
});

describe('AdminPaginationControls', () => {
  it('renders controls and forwards user actions', () => {
    const onPageSizeChange = vi.fn();
    const onPreviousPage = vi.fn();
    const onNextPage = vi.fn();
    const onPageSelect = vi.fn();
    const onJumpPageValueChange = vi.fn();
    const onJumpPage = vi.fn();

    render(
      <AdminPaginationControls
        label="测试分页"
        pageSize={50}
        pagination={{ totalItems: 101, page: 2, totalPages: 6, startIndex: 50, endIndex: 100, itemStart: 51, itemEnd: 100 }}
        visiblePages={[1, 2, 3]}
        jumpPageValue="2"
        onPageSizeChange={onPageSizeChange}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onPageSelect={onPageSelect}
        onJumpPageValueChange={onJumpPageValueChange}
        onJumpPage={onJumpPage}
      />,
    );

    fireEvent.keyDown(screen.getByRole('combobox', { name: '每页条数' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('option', { name: '100 条' }));
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    fireEvent.click(screen.getByRole('button', { name: '第 3 页' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(onPageSizeChange).toHaveBeenCalledWith(100);
    expect(onPreviousPage).toHaveBeenCalledTimes(1);
    expect(onNextPage).toHaveBeenCalledTimes(1);
    expect(onPageSelect).toHaveBeenCalledWith(3);
    expect(onJumpPageValueChange).toHaveBeenCalledWith('3');
    expect(onJumpPage).toHaveBeenCalledTimes(1);
    expect(screen.getByText('显示 51–100 条，共 101 条')).toBeTruthy();
  });
});
