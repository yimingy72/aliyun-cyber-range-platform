import type { ReactNode } from 'react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function AdminFormField({ label, htmlFor, required, hint, className, children }: { label: string; htmlFor?: string; required?: boolean; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <div className="flex items-center gap-1.5"><Label className="text-xs leading-5" htmlFor={htmlFor}>{label}</Label>{required ? <span aria-hidden="true" className="text-xs text-destructive">*</span> : null}</div>
      {children}
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
