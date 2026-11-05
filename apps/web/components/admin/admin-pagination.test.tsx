import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPaginationControls, buildVisiblePages, getPagination } from './admin-pagination';
import { AdminPaginatedList } from './shared/admin-paginated-list';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });

afterEach(cleanup);
const props = (page = 2, total = 101) => ({
  label: '测试分页', pageSize: 20 as const, pagination: getPagination(total, page, 20),
  onPageSizeChange: vi.fn(), onPageSelect: vi.fn(),
});
describe('admin pagination boundaries', () => {
  it('clamps the selected page and keeps the slice and displayed range consistent', () => {
    expect(getPagination(101, 99, 20)).toEqual({ totalItems: 101, page: 6, totalPages: 6,
      startIndex: 100, endIndex: 120, itemStart: 101, itemEnd: 101 });
    expect(getPagination(-5, NaN, 0)).toMatchObject({ totalItems: 0, page: 1, totalPages: 1, itemStart: 0, itemEnd: 0 });
    expect(getPagination(21, 1.9, 20)).toMatchObject({ page: 1, itemStart: 1, itemEnd: 20 });
  });
  it('shows small ranges in full and uses stable boundary windows for long ranges', () => {
    expect(buildVisiblePages(6, 1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildVisiblePages(10, 1)).toEqual([1, 2, 3, 4, 5, 'ellipsis-right', 10]);
    expect(buildVisiblePages(10, 5)).toEqual([1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 10]);
    expect(buildVisiblePages(10, 10)).toEqual([1, 'ellipsis-left', 6, 7, 8, 9, 10]);
    for (const count of [1, 2, 7, 8, 10, 100]) for (let page = 1; page <= count; page++) {
      const numbers = buildVisiblePages(count, page).filter((value): value is number => typeof value === 'number');
      expect(numbers).toContain(page);
      expect(numbers[0]).toBe(1);
      expect(numbers.at(-1)).toBe(count);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });
});
describe('framework pagination integration', () => {
  it('uses shadcn navigation and current-page semantics and forwards normalized actions', () => {
    const p = props(); render(<AdminPaginationControls {...p} />);
    expect(screen.getByRole('navigation', { name: '测试分页导航' }).getAttribute('data-slot')).toBe('pagination');
    expect(screen.getByRole('link', { name: '第 2 页' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('link', { name: '上一页' }));
    fireEvent.click(screen.getByRole('link', { name: '下一页' }));
    fireEvent.click(screen.getByRole('link', { name: '第 6 页' }));
    expect(p.onPageSelect.mock.calls.map(([page]) => page)).toEqual([1, 3, 6]);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '每页条数' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: '100 条' }));
    expect(p.onPageSizeChange).toHaveBeenCalledWith(100);
    expect(screen.getByText('显示 21–40 条，共 101 条')).toBeTruthy();
  });
  it('never sends a previous/next or current-page action outside the valid range', () => {
    const p = props(1); const view = render(<AdminPaginationControls {...p} />);
    const previous = screen.getByRole('link', { name: '上一页' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    expect(previous.tabIndex).toBe(-1);
    fireEvent.click(previous); fireEvent.click(screen.getByRole('link', { name: '第 1 页' }));
    expect(p.onPageSelect).not.toHaveBeenCalled();
    view.rerender(<AdminPaginationControls {...p} pagination={getPagination(101, 6, 20)} />);
    fireEvent.click(screen.getByRole('link', { name: '下一页' }));
    expect(screen.getByRole('link', { name: '下一页' }).getAttribute('aria-disabled')).toBe('true');
    expect(p.onPageSelect).not.toHaveBeenCalled();
  });
  it.each([['99', 6], ['0', 1], ['-3', 1], ['3', 3]])('normalizes jump %s before any client or server callback', (input, expected) => {
    const p = props(); render(<AdminPaginationControls {...p} />);
    const field = screen.getByRole('spinbutton', { name: '跳转到页码' });
    fireEvent.change(field, { target: { value: input } }); fireEvent.submit(field.closest('form')!);
    expect(p.onPageSelect).toHaveBeenCalledWith(expected);
    expect((field as HTMLInputElement).value).toBe(String(expected));
  });
  it.each(['', '1.5'])('does not treat invalid jump %s as a valid page', input => {
    const p = props(); render(<AdminPaginationControls {...p} />);
    const field = screen.getByRole('spinbutton', { name: '跳转到页码' });
    fireEvent.change(field, { target: { value: input } }); fireEvent.click(screen.getByRole('button', { name: '跳转' }));
    expect(p.onPageSelect).not.toHaveBeenCalled();
    expect((field as HTMLInputElement).value).toBe('2');
  });
  it('preserves a typed destination on unrelated rerenders and resets it on actual page change', () => {
    const p = props(); const view = render(<AdminPaginationControls {...p} />);
    const field = screen.getByRole('spinbutton', { name: '跳转到页码' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '6' } });
    view.rerender(<AdminPaginationControls {...p} />); expect(field.value).toBe('6');
    view.rerender(<AdminPaginationControls {...p} pagination={getPagination(101, 3, 20)} />); expect(field.value).toBe('3');
  });
  it('returns the actual list scroll owner to the top after changing pages', () => {
    function Harness() {
      const [page, setPage] = useState(1);
      return <AdminPaginatedList footer={<AdminPaginationControls {...props(page)} onPageSelect={setPage} />}>rows</AdminPaginatedList>;
    }
    render(<Harness />);
    const body = screen.getByRole('region', { name: '列表内容，可滚动' }); body.scrollTop = 200;
    fireEvent.click(screen.getByRole('link', { name: '下一页' })); expect(body.scrollTop).toBe(0);
  });
});
