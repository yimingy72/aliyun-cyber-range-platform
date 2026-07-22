import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmActionDialog } from './confirm-action-dialog';

const dialogProps = {
  open: true,
  title: '删除靶场',
  description: '删除后无法恢复。',
  confirmLabel: '删除靶场',
};

afterEach(cleanup);

describe('ConfirmActionDialog', () => {
  it('forwards cancel and destructive confirmation actions', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmActionDialog
        {...dialogProps}
        pending={false}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    const confirmButton = screen.getByRole('button', { name: '删除靶场' });
    expect(confirmButton.getAttribute('data-variant')).toBe('destructive');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(confirmButton);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while pending', () => {
    const onOpenChange = vi.fn();

    render(
      <ConfirmActionDialog
        {...dialogProps}
        pending
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '删除靶场' }).hasAttribute('disabled')).toBe(true);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('keeps a pending dialog open when the pointer moves outside', async () => {
    const onOpenChange = vi.fn();

    render(
      <ConfirmActionDialog
        {...dialogProps}
        pending
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />,
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    fireEvent.pointerDown(document.body);

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
