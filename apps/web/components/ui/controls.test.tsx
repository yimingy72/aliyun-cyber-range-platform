import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Combobox } from './combobox';
import { DateTimePicker, parseLocalDate } from './date-time-picker';

afterEach(cleanup);

function DateField({ includeTime = true }: { includeTime?: boolean }) {
  const [value, setValue] = useState(includeTime ? '2026-10-13T16:30' : '2026-10-13');
  return <form><DateTimePicker aria-label="到期时间" id="expiry" includeTime={includeTime} value={value} onValueChange={setValue} /><output aria-label="保存值">{value}</output></form>;
}

describe('shared form controls', () => {
  it('opens the calendar from the input surface and applies time without submitting the form', () => {
    render(<DateField />);
    const input = screen.getByRole('textbox', { name: '到期时间' });
    fireEvent.click(input);
    const calendar = screen.getByRole('dialog', { name: '选择到期时间' });
    expect(calendar.closest('form')).toBeNull();
    fireEvent.change(within(calendar).getByLabelText('时间'), { target: { value: '17:45' } });
    expect(screen.getByLabelText('保存值').textContent).toBe('2026-10-13T16:30');
    fireEvent.click(within(calendar).getByRole('button', { name: '确定' }));
    expect(screen.getByLabelText('保存值').textContent).toBe('2026-10-13T17:45');
    expect(document.activeElement).toBe(input);
  });

  it('supports keyboard opening, manual entry and a date-only field', () => {
    render(<DateField includeTime={false} />);
    const input = screen.getByRole('textbox', { name: '到期时间' });
    fireEvent.change(input, { target: { value: '2026-10-14' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('dialog', { name: '选择到期时间' })).toBeTruthy();
    expect(screen.getByLabelText('保存值').textContent).toBe('2026-10-14');
    expect(screen.queryByLabelText('时间')).toBeNull();
  });

  it('keeps local dates and rejects invalid calendar dates and times', () => {
    const date = parseLocalDate('2028-02-29T12:30');
    expect(date?.getFullYear()).toBe(2028);
    expect(date?.getHours()).toBe(12);
    expect(parseLocalDate('2027-02-29T12:30')).toBeUndefined();
    expect(parseLocalDate('2026-10-13T24:01')).toBeUndefined();
    expect(parseLocalDate('2026-13-01', false)).toBeUndefined();
    expect(parseLocalDate('')).toBeUndefined();
  });

  it('preserves browser form validation when a date is typed manually', () => {
    render(<DateField />);
    const input = screen.getByRole('textbox', { name: '到期时间' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2027-02-29 12:30' } });
    expect(input.checkValidity()).toBe(false);
    fireEvent.change(input, { target: { value: '2028-02-29 12:30' } });
    expect(input.checkValidity()).toBe(true);
  });

  it('allows searching and keyboard selection in a portalled listbox', () => {
    const onChange = vi.fn();
    const { container } = render(<div style={{ overflow: 'hidden' }}><Combobox ariaLabel="镜像" value="" onValueChange={onChange} options={[{ value: 'ubuntu', label: 'Ubuntu' }, { value: 'windows', label: 'Windows' }]} /></div>);
    const input = screen.getByRole('combobox', { name: '镜像' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const list = screen.getByRole('listbox', { name: '镜像候选列表' });
    expect(container.contains(list)).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBe(within(list).getByRole('option', { name: 'Windows' }).id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('windows');
  });

  it('renders an empty search result and respects disabled controls', () => {
    const props = { ariaLabel: '镜像', value: 'missing', onValueChange: vi.fn(), options: [{ value: 'ubuntu', label: 'Ubuntu' }] };
    const { rerender } = render(<Combobox {...props} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('没有匹配的选项')).toBeTruthy();
    rerender(<Combobox {...props} disabled />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true);
  });
});
