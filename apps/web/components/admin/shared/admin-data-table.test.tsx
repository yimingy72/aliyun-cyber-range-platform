import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TableRow } from '@/components/ui/table';

import { AdminDataTable, AdminDataTableCell, AdminDataTableState } from './admin-data-table';

afterEach(cleanup);

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

  it('contains long values within fixed columns and allows them to wrap', () => {
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

    const cell = screen.getByRole('cell', { name: longName });

    expect(cell.className).toContain('min-w-0');
    expect(cell.className).toContain('overflow-hidden');
    expect(cell.className).toContain('break-words');
    expect(cell.className).toContain('whitespace-normal');
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
