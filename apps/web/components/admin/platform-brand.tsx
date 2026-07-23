import { cn } from '@/lib/utils';

type PlatformBrandProps = {
  className?: string;
  compact?: boolean;
};

export function PlatformBrand({ className, compact = false }: PlatformBrandProps) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2.5 text-sm text-foreground', className)}
      data-slot="platform-brand"
    >
      <img
        alt=""
        aria-hidden="true"
        className={cn('shrink-0', compact ? 'size-6' : 'size-7')}
        data-testid="platform-brand-mark"
        height={compact ? 24 : 28}
        src="/brand/platform-mark.svg"
        width={compact ? 24 : 28}
      />
      <span className="truncate font-semibold">综合靶场平台</span>
    </span>
  );
}
