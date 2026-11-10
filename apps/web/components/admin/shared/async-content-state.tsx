'use client';

import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { AdminNotice } from './admin-notice';

interface AsyncContentStateProps {
  title: string;
  description: string;
  variant: 'empty' | 'error';
  action?: ReactNode;
  onRetry?: () => void;
}

export function AsyncContentState({ title, description, variant, action, onRetry }: AsyncContentStateProps) {
  if (variant === 'error') {
    return <AdminNotice
      className="w-full"
      tone="error"
      actions={action || onRetry ? <>{action}{onRetry ? <Button onClick={onRetry} type="button" size="sm" variant="outline">重试加载</Button> : null}</> : null}
    >
      <h2 className="font-heading font-semibold">{title}</h2>
      <p className="mt-1">{description}</p>
    </AdminNotice>;
  }
  return (
    <section className="flex flex-col items-start gap-3 py-8" data-slot="async-content-state" data-variant={variant}>
      <div>
        <h2 className="font-heading text-base font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {action}
      </div>
    </section>
  );
}
