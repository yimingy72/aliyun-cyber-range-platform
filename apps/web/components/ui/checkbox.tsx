'use client';

import type { ComponentProps } from 'react';
import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-card outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground', className)} {...props}>
      <CheckboxPrimitive.Indicator><Check className="size-3" /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
