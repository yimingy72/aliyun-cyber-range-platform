'use client';

import { type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Inbox } from 'lucide-react';

import { AsyncContentState } from '@/components/admin/shared/async-content-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type AdminDataColumn = {
  id: string;
  label: string;
  priority: 'primary' | 'secondary' | 'tertiary' | 'detail';
  align?: 'left' | 'right';
  width?: string;
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

interface AdminDataTableTextProps {
  children: ReactNode;
  className?: string;
  tooltipContent?: ReactNode;
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
    <TooltipProvider>
      <div className="overflow-hidden rounded border border-border bg-background" data-slot="admin-data-table-frame">
        <Table aria-busy={isRefreshing || undefined} aria-label={label} className="min-w-full table-fixed">
          <colgroup>
            {columns.map((column) => (
              <col
                className={columnPriorityColumnClassName(column.priority)}
                key={column.id}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
          </colgroup>
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead
                  className={cn(
                    'h-11 min-w-0 overflow-hidden break-words px-3 whitespace-normal',
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
      </div>
    </TooltipProvider>
  );
}

export function AdminDataTableText({ children, className, tooltipContent }: AdminDataTableTextProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('block min-w-0 truncate', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all whitespace-normal" sideOffset={6}>
        {tooltipContent ?? children}
      </TooltipContent>
    </Tooltip>
  );
}

export function AdminDataTableCell({ column, className, children, ...props }: AdminDataTableCellProps) {
  const isPlainText = typeof children === 'string' || typeof children === 'number';

  return (
    <TableCell
      className={cn(
        'min-w-0 overflow-hidden px-3 whitespace-nowrap',
        columnPriorityClassName(column.priority),
        column.align === 'right' && 'text-right',
        className,
      )}
      {...props}
    >
      {isPlainText ? <AdminDataTableText>{children}</AdminDataTableText> : children}
    </TableCell>
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
