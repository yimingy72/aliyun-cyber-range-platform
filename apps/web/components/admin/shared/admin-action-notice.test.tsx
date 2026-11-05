import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminActionNotice } from './admin-action-notice';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('dismisses after five seconds even when the caller rerenders, and allows immediate dismissal', () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const view = render(<AdminActionNotice message="操作已完成" onDismiss={() => dismiss()} />);
  expect(screen.getByRole('status').textContent).toBe('操作已完成');
  act(() => vi.advanceTimersByTime(3000));
  view.rerender(<AdminActionNotice message="操作已完成" onDismiss={() => dismiss()} />);
  act(() => vi.advanceTimersByTime(2000));
  expect(dismiss).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭操作提示' }));
  expect(dismiss).toHaveBeenCalledTimes(2);
  view.rerender(<AdminActionNotice message={null} onDismiss={dismiss} />);
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(5000));
  expect(dismiss).toHaveBeenCalledTimes(2);
});
