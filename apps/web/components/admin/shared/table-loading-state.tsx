import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';

interface TableLoadingStateProps {
  columnCount: number;
  rowCount: number;
  label: string;
}

export function TableLoadingState({ columnCount, rowCount, label }: TableLoadingStateProps) {
  return Array.from({ length: rowCount }, (_, index) => (
    <TableRow data-testid="table-loading-row" key={index}>
      <TableCell colSpan={columnCount}>
        {index === 0 ? (
          <span aria-label={label} className="sr-only" role="status">
            {label}
          </span>
        ) : null}
        <Skeleton aria-hidden="true" className="h-4 w-full" />
      </TableCell>
    </TableRow>
  ));
}
