import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Table, TableBody } from '@/components/ui/table';

import { TableLoadingState } from './table-loading-state';

afterEach(cleanup);

describe('TableLoadingState', () => {
  it('renders valid table rows and an announced loading status', () => {
    render(
      <Table>
        <TableBody>
          <TableLoadingState columnCount={5} rowCount={3} label="正在加载靶场编排" />
        </TableBody>
      </Table>,
    );

    const rows = screen.getAllByTestId('table-loading-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole('status', { name: '正在加载靶场编排' })).toBeTruthy();

    for (const row of rows) {
      const cell = row.querySelector('td');
      expect(cell?.getAttribute('colspan')).toBe('5');
    }
  });
});
