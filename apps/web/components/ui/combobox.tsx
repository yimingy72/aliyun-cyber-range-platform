'use client';

import { useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type ComboboxOption = { value: string; label: string; description?: string };
type ComboboxProps = {
  id?: string;
  ariaLabel: string;
  value: string;
  selectedValue?: string;
  onValueChange: (value: string) => void;
  options: readonly ComboboxOption[];
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
};

export function Combobox({ id, ariaLabel, value, selectedValue = value, onValueChange, options, disabled, required, placeholder = '搜索或选择' }: ComboboxProps) {
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = value.trim().toLowerCase();
  const isSelectedValue = options.some((option) => option.value === value || (option.value === selectedValue && option.label === value));
  const filtered = options.filter((option) => isSelectedValue || `${option.label} ${option.description ?? ''} ${option.value}`.toLowerCase().includes(query));

  function select(option: ComboboxOption) {
    onValueChange(option.value);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative min-w-0" ref={anchorRef}>
          <Input
            aria-label={ariaLabel}
            aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-expanded={open && !disabled}
            autoComplete="off"
            className="pr-9"
            disabled={disabled}
            id={id}
            placeholder={placeholder}
            ref={inputRef}
            required={required}
            role="combobox"
            value={value}
            onChange={(event) => { onValueChange(event.target.value); setActiveIndex(-1); setOpen(true); }}
            onClick={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                const nextIndex = !filtered.length ? -1 : activeIndex < 0 ? (event.key === 'ArrowDown' ? 0 : filtered.length - 1) : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
                setActiveIndex(nextIndex);
                document.getElementById(`${listId}-${nextIndex}`)?.scrollIntoView?.({ block: 'nearest' });
              }
              if (event.key === 'Enter' && open) {
                event.preventDefault();
                const option = filtered[activeIndex] ?? filtered.find((item) => item.value === value || item.label === value);
                if (option) select(option);
              }
              if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
            }}
          />
          <Button aria-label={`展开${ariaLabel}选项`} className="absolute top-0.5 right-0.5" disabled={disabled} size="icon-sm" type="button" variant="ghost" onClick={() => { setOpen(!open); inputRef.current?.focus(); }}>
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        role="presentation"
        className="w-(--radix-popover-trigger-width) min-w-52 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => { if (anchorRef.current?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <div aria-label={`${ariaLabel}候选列表`} className="max-h-56 overflow-y-auto" id={listId} role="listbox">
          {filtered.length ? filtered.map((option, index) => (
            <Button
              aria-label={option.label}
              aria-selected={option.value === selectedValue}
              className={cn('h-auto min-h-9 w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left whitespace-normal', activeIndex === index && 'bg-accent text-accent-foreground')}
              id={`${listId}-${index}`}
              key={option.value}
              role="option"
              tabIndex={-1}
              type="button"
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
            >
              <span className="min-w-0 flex-1 break-all"><span className="block">{option.label}</span>{option.description ? <span className="block text-xs text-muted-foreground">{option.description}</span> : null}</span>
              {option.value === selectedValue ? <Check aria-hidden="true" className="size-4 text-primary" /> : null}
            </Button>
          )) : <p className="px-2 py-3 text-xs text-muted-foreground">没有匹配的选项</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
