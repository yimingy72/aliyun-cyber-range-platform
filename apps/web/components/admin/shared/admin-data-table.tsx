'use client';

import { type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Inbox } from 'lucide-react';

import { AsyncContentState } from '@/components/admin/shared/async-content-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type AdminDataColumn = {
  id: string;
  label: string;
  priority: 'primary' | 'secondary' | 'tertiary' | 'detail';
  align?: 'left' | 'right';
};

interface AdminDataTableProps {
  label: string;
  columns: readonly AdminDataColumn[];
  children: (columns: readonly AdminDataColumn[]) => ReactNode;
  isRefreshing?: boolean;
}

interface AdminDataTableStateProps {
  columns: readonly AdminDataColumn[];
  title: string;
  description: string;
  variant: 'empty' | 'error';
  action?: ReactNode;
  onRetry?: () => void;
}

interface AdminDataTableCellProps extends ComponentProps<typeof TableCell> {
  column: AdminDataColumn;
}

function columnPriorityClassName(priority: AdminDataColumn['priority']) {
  if (priority === 'secondary') {
    return 'hidden md:table-cell';
  }

  if (priority === 'tertiary') {
    return 'hidden lg:table-cell';
  }

  if (priority === 'detail') {
    return 'hidden xl:table-cell';
  }

  return undefined;
}

function columnPriorityColumnClassName(priority: AdminDataColumn['priority']) {
  if (priority === 'secondary') {
    return 'hidden md:table-column';
  }

  if (priority === 'tertiary') {
    return 'hidden lg:table-column';
  }

  if (priority === 'detail') {
    return 'hidden xl:table-column';
  }

  return undefined;
}

export function AdminDataTable({ label, columns, children, isRefreshing = false }: AdminDataTableProps) {
  return (
    <Table aria-busy={isRefreshing || undefined} aria-label={label} className="min-w-full">
      <colgroup>
        {columns.map((column) => (
          <col className={columnPriorityColumnClassName(column.priority)} key={column.id} />
        ))}
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((column) => (
            <TableHead
              className={cn(
                'h-11 px-3',
                columnPriorityClassName(column.priority),
                column.align === 'right' && 'text-right',
              )}
              key={column.id}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children(columns)}</TableBody>
    </Table>
  );
}

export function AdminDataTableCell({ column, className, ...props }: AdminDataTableCellProps) {
  return (
    <TableCell
      className={cn(
        'px-3',
        columnPriorityClassName(column.priority),
        column.align === 'right' && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function AdminDataTableState({
  columns,
  title,
  description,
  variant,
  action,
  onRetry,
}: AdminDataTableStateProps) {
  const Icon = variant === 'empty' ? Inbox : CircleAlert;

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="h-56 px-3 py-6 align-middle whitespace-normal" colSpan={columns.length}>
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
          <AsyncContentState
            action={action}
            description={description}
            onRetry={onRetry}
            title={title}
            variant={variant}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
