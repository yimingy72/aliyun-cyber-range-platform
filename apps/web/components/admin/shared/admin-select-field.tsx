'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const EMPTY_OPTION_VALUE = '__admin-select-empty__';

type AdminSelectOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

type AdminSelectFieldProps = {
  ariaLabel: string;
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly AdminSelectOption[];
  emptyOptionLabel?: string;
  disabled?: boolean;
  className?: string;
};

export function AdminSelectField({
  ariaLabel,
  className,
  disabled = false,
  emptyOptionLabel,
  id,
  onValueChange,
  options,
  value,
}: AdminSelectFieldProps) {
  const selectedValue = value || (emptyOptionLabel ? EMPTY_OPTION_VALUE : undefined);

  return (
    <Select
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange(nextValue === EMPTY_OPTION_VALUE ? '' : nextValue)}
      value={selectedValue}
    >
      <SelectTrigger aria-label={ariaLabel} className={className ?? 'w-full'} id={id}>
        <SelectValue placeholder={emptyOptionLabel ?? '请选择'} />
      </SelectTrigger>
      <SelectContent position="popper">
        {emptyOptionLabel ? <SelectItem value={EMPTY_OPTION_VALUE}>{emptyOptionLabel}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
