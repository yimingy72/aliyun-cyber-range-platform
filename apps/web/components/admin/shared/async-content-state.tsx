'use client';

import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface AsyncContentStateProps {
  title: string;
  description: string;
  variant: 'empty' | 'error';
  action?: ReactNode;
  onRetry?: () => void;
}

export function AsyncContentState({ title, description, variant, action, onRetry }: AsyncContentStateProps) {
  return (
    <section className="flex flex-col items-start gap-3 py-8" data-variant={variant}>
      <div>
        <h2 className="font-heading text-base font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {variant === 'error' && onRetry ? (
          <Button onClick={onRetry} type="button" variant="outline">
            重试加载
          </Button>
        ) : null}
      </div>
    </section>
  );
}
