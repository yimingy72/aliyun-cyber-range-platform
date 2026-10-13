'use client';

import type { ComponentProps } from 'react';
import { DayPicker } from '@daypicker/react';
import { zhCN } from '@daypicker/react/locale';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Calendar({ className, ...props }: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      locale={zhCN}
      weekStartsOn={1}
      showOutsideDays
      className={cn('relative w-64 max-w-full', className)}
      classNames={{
        months: 'relative',
        month_caption: 'flex h-8 items-center justify-center px-9 font-medium',
        nav: 'absolute inset-x-0 top-0 flex justify-between',
        button_previous: buttonVariants({ variant: 'ghost', size: 'icon' }),
        button_next: buttonVariants({ variant: 'ghost', size: 'icon' }),
        chevron: 'size-4 fill-current',
        month_grid: 'w-full border-collapse',
        weekday: 'h-8 text-xs font-normal text-muted-foreground',
        day: 'p-0 text-center',
        day_button: cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'mx-auto size-9 font-normal tabular-nums'),
        selected: '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary',
        today: '[&>button]:ring-1 [&>button]:ring-primary/40',
        outside: 'text-muted-foreground',
        disabled: 'opacity-40',
        hidden: 'invisible',
      }}
      {...props}
    />
  );
}
