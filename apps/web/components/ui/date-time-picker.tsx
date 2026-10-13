'use client';

import { type ComponentProps, useEffect, useId, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type DateTimePickerProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  value: string;
  onValueChange: (value: string) => void;
  includeTime?: boolean;
};

export function parseLocalDate(value: string, includeTime = true): Date | undefined {
  const match = value.match(includeTime ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour = '0', minute = '0'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) && date.getHours() === Number(hour) && date.getMinutes() === Number(minute) ? date : undefined;
}

function formatLocalDate(date: Date, includeTime: boolean) {
  const pad = (part: number) => String(part).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return includeTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function DateTimePicker({ value, onValueChange, includeTime = true, className, disabled, readOnly, id, 'aria-label': ariaLabel, ...props }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState(() => parseLocalDate(value, includeTime) ?? new Date());
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const timeId = `${id ?? generatedId}-time`;
  const anchorRef = useRef<HTMLDivElement>(null);
  const selected = parseLocalDate(draft, includeTime);
  const label = ariaLabel ?? (includeTime ? '日期时间' : '日期');
  useEffect(() => {
    inputRef.current?.setCustomValidity(value && !parseLocalDate(value, includeTime) ? '请输入有效的日期和时间。' : '');
  }, [value, includeTime]);

  function changeOpen(next: boolean) {
    if (disabled || readOnly) return;
    if (next) {
      const nextDraft = value || formatLocalDate(new Date(Date.now() + 3_600_000), includeTime);
      setDraft(nextDraft);
      setMonth(parseLocalDate(nextDraft, includeTime) ?? new Date());
    }
    setOpen(next);
  }

  function commit(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverAnchor asChild>
        <div className={cn('relative min-w-0', className)} ref={anchorRef}>
          <Input
            {...props}
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-invalid={props['aria-invalid'] || (!!value && !parseLocalDate(value, includeTime)) || undefined}
            autoComplete="off"
            className="pr-9 tabular-nums"
            disabled={disabled}
            id={id}
            pattern={includeTime ? '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}' : '\\d{4}-\\d{2}-\\d{2}'}
            placeholder={includeTime ? '选择日期和时间' : '选择日期'}
            readOnly={readOnly}
            ref={inputRef}
            value={value.replace('T', ' ')}
            onClick={() => changeOpen(true)}
            onChange={(event) => {
              const nextValue = event.target.value.replace(' ', 'T');
              onValueChange(nextValue);
              setDraft(nextValue);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); changeOpen(true); }
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          <PopoverTrigger asChild>
            <Button aria-label={`选择${label}`} className="absolute top-0.5 right-0.5" disabled={disabled || readOnly} size="icon-sm" type="button" variant="ghost">
              <CalendarDays aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        aria-label={`选择${label}`}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => { if (anchorRef.current?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <Calendar
          mode="single"
          month={month}
          selected={selected}
          onMonthChange={setMonth}
          onSelect={(day) => {
            if (!day) return;
            day.setHours(selected?.getHours() ?? 12, selected?.getMinutes() ?? 0);
            const nextValue = formatLocalDate(day, includeTime);
            if (includeTime) setDraft(nextValue); else commit(nextValue);
          }}
        />
        {includeTime ? (
          <div className="mt-3 grid gap-3 border-t border-border pt-3">
            <div className="flex items-center gap-3">
              <Label className="shrink-0 text-xs whitespace-nowrap" htmlFor={timeId}>时间</Label>
              <Input id={timeId} type="time" value={draft.slice(11)} onChange={(event) => setDraft(`${draft.slice(0, 10)}T${event.target.value}`)} />
            </div>
            <div className="flex gap-1">
              {[1, 4, 24].map((hours) => <Button key={hours} size="sm" type="button" variant="outline" onClick={() => commit(formatLocalDate(new Date(Date.now() + hours * 3_600_000), true))}>{hours === 24 ? '1 天后' : `${hours} 小时后`}</Button>)}
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <Button disabled={props.required} size="sm" type="button" variant="ghost" onClick={() => commit('')}>清空</Button>
          <Button disabled={!selected} size="sm" type="button" onClick={() => commit(draft)}>确定</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
