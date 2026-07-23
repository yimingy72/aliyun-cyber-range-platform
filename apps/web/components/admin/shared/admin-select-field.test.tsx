import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminSelectField } from './admin-select-field';

describe('AdminSelectField', () => {
  afterEach(() => {
    cleanup();
  });

  it('maps its visible empty option back to an empty string', () => {
    const onValueChange = vi.fn();

    render(
      <AdminSelectField
        ariaLabel="筛选用户"
        emptyOptionLabel="全部用户"
        onValueChange={onValueChange}
        options={[{ label: 'admin', value: 'admin-id' }]}
        value="admin-id"
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '筛选用户' }));
    fireEvent.click(screen.getByRole('option', { name: '全部用户' }));

    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('keeps the trigger disabled without rendering a native select', () => {
    render(
      <AdminSelectField
        ariaLabel="筛选用户"
        disabled
        emptyOptionLabel="全部用户"
        onValueChange={() => undefined}
        options={[]}
        value=""
      />,
    );

    expect(screen.getByRole('combobox', { name: '筛选用户' }).hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('select')).toBeNull();
  });
});
