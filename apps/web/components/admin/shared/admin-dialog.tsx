'use client';

import type * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type AdminDialogSize = 'compact' | 'standard' | 'wide';

type AdminDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  size?: AdminDialogSize;
  pending?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function AdminDialog({
  open,
  title,
  description,
  size = 'standard',
  pending = false,
  initialFocusRef,
  onOpenChange,
  children,
  footer,
}: AdminDialogProps) {
  const handleOpenChange = (nextOpen: boolean) => {
    if (pending && !nextOpen) {
      return;
    }

    onOpenChange(nextOpen);
  };

  const preventPendingClose = (event: Event) => {
    if (pending) {
      event.preventDefault();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn('admin-dialog-content', `admin-dialog-size-${size}`)}
        closeButtonDisabled={pending}
        onEscapeKeyDown={preventPendingClose}
        onInteractOutside={preventPendingClose}
        onOpenAutoFocus={(event) => {
          if (!initialFocusRef?.current) {
            return;
          }

          event.preventDefault();
          initialFocusRef.current.focus();
        }}
        onPointerDownOutside={preventPendingClose}
      >
        <DialogHeader className="admin-dialog-header">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="admin-dialog-body">{children}</div>
        {footer ? <DialogFooter className="admin-dialog-footer">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

type AdminConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function AdminConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  pending,
  onOpenChange,
  onConfirm,
}: AdminConfirmationDialogProps) {
  return (
    <AdminDialog
      description={description}
      footer={
        <>
          <Button disabled={pending} type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button disabled={pending} type="button" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
      open={open}
      pending={pending}
      size="compact"
      title={title}
      onOpenChange={onOpenChange}
    >
      <span className="sr-only">确认操作</span>
    </AdminDialog>
  );
}
