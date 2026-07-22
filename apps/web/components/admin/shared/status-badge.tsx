import { Badge } from '@/components/ui/badge';

interface StatusBadgeProps {
  status: 'published' | 'private';
}

const statusConfig = {
  published: {
    label: '已发布',
    variant: 'default',
  },
  private: {
    label: '私有',
    variant: 'secondary',
  },
} as const;

export function StatusBadge({ status }: StatusBadgeProps) {
  const { label, variant } = statusConfig[status];

  return (
    <Badge data-status={status} variant={variant}>
      {label}
    </Badge>
  );
}
