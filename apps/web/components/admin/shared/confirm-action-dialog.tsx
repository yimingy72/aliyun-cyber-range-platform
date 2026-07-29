'use client';

import { AdminConfirmationDialog } from './admin-dialog';

interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  pending,
  onOpenChange,
  onConfirm,
}: ConfirmActionDialogProps) {
  return (
    <AdminConfirmationDialog
      confirmLabel={confirmLabel}
      description={description}
      open={open}
      pending={pending}
      title={title}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
    />
  );
}
