import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TableRow } from '@/components/ui/table';

import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
} from './admin-data-table';

class ResizeObserverMock {
  private static readonly observers = new Set<ResizeObserverMock>();
  private observedElement: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.observers.add(this);
  }

  disconnect() {
    ResizeObserverMock.observers.delete(this);
  }

  observe(element: Element) {
    this.observedElement = element;
  }

  unobserve(element: Element) {
    if (this.observedElement === element) {
      this.observedElement = null;
    }
  }

  static notify(element: Element) {
    for (const observer of ResizeObserverMock.observers) {
      if (observer.observedElement === element) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  }

  static reset() {
    ResizeObserverMock.observers.clear();
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

afterEach(() => {
  cleanup();
  ResizeObserverMock.reset();
  vi.useRealTimers();
});

const instanceColumns = [
  { id: 'name', label: '实例名称', priority: 'primary' as const },
  { id: 'image', label: '镜像', priority: 'secondary' as const },
  { id: 'status', label: '状态', priority: 'primary' as const },
  { id: 'actions', label: '操作', priority: 'primary' as const, align: 'right' as const },
];

describe('AdminDataTable', () => {
  it('keeps feature columns visible while the table body is empty', () => {
    render(
      <AdminDataTable columns={instanceColumns} label="实例列表">
        {(columns) => (
          <AdminDataTableState
            columns={columns}
            description="创建后，实例状态会显示在这里。"
            title="还没有实例"
            variant="empty"
          />
        )}
      </AdminDataTable>,
    );

    expect(screen.getByRole('columnheader', { name: '实例名称' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy();
    expect(screen.getByText('还没有实例')).toBeTruthy();
  });

  it('reports a retained snapshot as busy without replacing table rows', () => {
    const columns = [{ id: 'name', label: '实例名称', priority: 'primary' as const }];

    render(
      <AdminDataTable columns={columns} isRefreshing label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    expect(screen.getByRole('table', { name: '实例列表' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('keeps retained rows with one compact retry notice after a refresh failure', () => {
    const retry = vi.fn();
    const columns = [{ id: 'name', label: '实例名称', priority: 'primary' as const }];

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <>
            <AdminDataTableRevalidationNotice
              columns={tableColumns}
              description="实例列表刷新失败。"
              onRetry={retry}
            />
            <TableRow>
              <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
            </TableRow>
          </>
        )}
      </AdminDataTable>,
    );

    expect(screen.getByRole('alert').textContent).toContain('正在显示上次成功加载的数据。');
    expect(screen.getByText('alpha')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('announces refresh immediately, delays only the visual indicator, and keys a completed body replacement', () => {
    const columns = [{ id: 'name', label: '实例名称', priority: 'primary' as const }];
    const { rerender } = render(
      <AdminDataTable columns={columns} contentVersion={1} isRefreshing label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const table = screen.getByRole('table', { name: '实例列表' });
    const frame = table.closest('[data-slot="admin-data-table-frame"]');
    const firstBody = table.querySelector('tbody');

    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(frame?.getAttribute('data-refreshing')).toBe('true');
    expect(frame?.querySelector('.admin-data-table-refresh-indicator')).toBeTruthy();
    expect(firstBody?.className).toContain('admin-data-table-body-enter');

    rerender(
      <AdminDataTable columns={columns} contentVersion={2} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>bravo</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const completedTable = screen.getByRole('table', { name: '实例列表' });

    expect(screen.getByText('bravo')).toBeTruthy();
    expect(completedTable.getAttribute('aria-busy')).toBeNull();
    expect(completedTable.querySelector('tbody')).not.toBe(firstBody);
  });

  it('wraps feature columns in the shared neutral table frame', () => {
    render(
      <AdminDataTable columns={instanceColumns} label="实例列表">
        {(columns) => (
          <TableRow>
            <AdminDataTableCell column={columns[0]}>alpha</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const table = screen.getByRole('table', { name: '实例列表' });
    const frame = table.closest('[data-slot="admin-data-table-frame"]');

    expect(frame?.className).toContain('rounded');
    expect(frame?.className).toContain('border');
    expect(frame?.className).toContain('bg-background');
    expect(table.querySelector('thead')?.className).toContain('bg-muted/60');
  });

  it('applies responsive priority and action alignment to feature-owned columns', () => {
    const columns = [
      { id: 'name', label: '实例名称', priority: 'primary' as const },
      { id: 'image', label: '镜像', priority: 'secondary' as const },
      { id: 'updatedAt', label: '更新时间', priority: 'tertiary' as const },
      { id: 'detail', label: '详情', priority: 'detail' as const },
      { id: 'actions', label: '操作', priority: 'primary' as const, align: 'right' as const },
    ];

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            {tableColumns.map((column) => (
              <AdminDataTableCell column={column} key={column.id}>
                {column.id}
              </AdminDataTableCell>
            ))}
          </TableRow>
        )}
      </AdminDataTable>,
    );

    expect(screen.getByRole('columnheader', { name: '镜像' }).className).toContain('hidden md:table-cell');
    expect(screen.getByRole('columnheader', { name: '更新时间' }).className).toContain('hidden lg:table-cell');
    expect(screen.getByRole('columnheader', { name: '详情' }).className).toContain('hidden xl:table-cell');
    expect(screen.getByRole('columnheader', { name: '操作' }).className).toContain('text-right');
    expect(screen.getByRole('columnheader', { name: '实例名称' }).className).toContain('overflow-hidden');
    expect(screen.getByRole('columnheader', { name: '实例名称' }).className).toContain('whitespace-normal');
    const tableColumns = screen.getByRole('table', { name: '实例列表' }).querySelectorAll('col');
    expect(tableColumns[1].className).toContain('hidden md:table-column');
    expect(tableColumns[2].className).toContain('hidden lg:table-column');
    expect(tableColumns[3].className).toContain('hidden xl:table-column');
  });

  it('applies feature-owned column widths through the shared colgroup', () => {
    const columns = [
      { id: 'name', label: '实例名称', priority: 'primary' as const, width: '28%' },
      { id: 'actions', label: '操作', priority: 'primary' as const, width: '12rem' },
    ];

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
            <AdminDataTableCell column={tableColumns[1]}>查看详情</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const table = screen.getByRole('table', { name: '实例列表' });
    const tableColumns = table.querySelectorAll('col');

    expect(table.className).toContain('table-fixed');
    expect(tableColumns[0].getAttribute('style') ?? '').toContain('width: 28%');
    expect(tableColumns[1].getAttribute('style') ?? '').toContain('width: 12rem');
  });

  it('uses explicit static Tailwind utilities for responsive colgroup priorities', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/admin/shared/admin-data-table.tsx'), 'utf8');

    expect(source).not.toContain('.replace(');
    expect(source).toContain("'hidden md:table-column'");
    expect(source).toContain("'hidden lg:table-column'");
    expect(source).toContain("'hidden xl:table-column'");
  });

  it('applies the shared column contract to feature-owned body cells', () => {
    const columns = [
      { id: 'name', label: '实例名称', priority: 'primary' as const },
      { id: 'image', label: '镜像', priority: 'secondary' as const },
      { id: 'detail', label: '详情', priority: 'detail' as const },
      { id: 'actions', label: '操作', priority: 'primary' as const, align: 'right' as const },
    ];

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
            <AdminDataTableCell column={tableColumns[1]}>Ubuntu</AdminDataTableCell>
            <AdminDataTableCell column={tableColumns[2]}>详情</AdminDataTableCell>
            <AdminDataTableCell column={tableColumns[3]}>更多操作</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    expect(screen.getByRole('cell', { name: 'Ubuntu' }).className).toContain('hidden md:table-cell');
    expect(screen.getByRole('cell', { name: '详情' }).className).toContain('hidden xl:table-cell');
    expect(screen.getByRole('cell', { name: '更多操作' }).className).toContain('text-right');
  });

  it('does not show a tooltip when a fixed-column value fits in full', async () => {
    vi.useFakeTimers();

    const columns = [{ id: 'creator', label: '创建人', priority: 'primary' as const }];

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>admin</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const value = screen.getByText('admin');

    Object.defineProperties(value, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 80 },
    });
    act(() => ResizeObserverMock.notify(value));

    fireEvent.pointerMove(value);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('truncates long values in fixed columns and reveals the full value with the shared tooltip', async () => {
    const columns = [{ id: 'name', label: '实例名称', priority: 'primary' as const }];
    const longName = 'Ubuntu-综合场景-四层拓扑-2026-07-27-实例名称非常非常长';

    render(
      <AdminDataTable columns={columns} label="实例列表">
        {(tableColumns) => (
          <TableRow>
            <AdminDataTableCell column={tableColumns[0]}>{longName}</AdminDataTableCell>
          </TableRow>
        )}
      </AdminDataTable>,
    );

    const value = screen.getByText(longName);

    expect(value.tagName).toBe('SPAN');
    expect(value.className).toContain('min-w-0');
    expect(value.className).toContain('truncate');

    Object.defineProperties(value, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 320 },
    });
    act(() => ResizeObserverMock.notify(value));

    fireEvent.pointerMove(value);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(longName);
    expect(tooltip.className).toContain('bg-sky-50');
  });

  it('derives an in-table state colspan from its feature columns', () => {
    const onRetry = vi.fn();

    render(
      <AdminDataTable columns={instanceColumns} label="实例列表">
        {(columns) => (
          <AdminDataTableState
            columns={columns}
            description="暂时无法读取实例。"
            onRetry={onRetry}
            title="加载实例失败"
            variant="error"
          />
        )}
      </AdminDataTable>,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('cell').getAttribute('colspan')).toBe(String(instanceColumns.length));
  });
});
