'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        onEscapeKeyDown={preventPendingClose}
        onInteractOutside={preventPendingClose}
        onPointerDownOutside={preventPendingClose}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button disabled={pending} onClick={() => handleOpenChange(false)} type="button" variant="outline">
            取消
          </Button>
          <Button disabled={pending} onClick={onConfirm} type="button" variant="destructive">
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
