import { Badge } from '@/components/ui/badge';

export type StatusBadgeStatus = string;

interface StatusBadgeProps {
  status: StatusBadgeStatus;
}

const statusConfig = {
  pending_create: {
    label: '等待创建',
    variant: 'secondary',
  },
  pending_destroy: {
    label: '等待销毁',
    variant: 'secondary',
  },
  published: {
    label: '已发布',
    variant: 'default',
  },
  private: {
    label: '私有',
    variant: 'secondary',
  },
  running: {
    label: '运行中',
    variant: 'default',
  },
  creating: {
    label: '创建中',
    variant: 'secondary',
  },
  create_failed: {
    label: '创建失败',
    variant: 'destructive',
  },
  destroying: {
    label: '销毁中',
    variant: 'secondary',
  },
  destroy_failed: {
    label: '销毁失败',
    variant: 'destructive',
  },
  destroyed: {
    label: '已销毁',
    variant: 'outline',
  },
  draft: {
    label: '草稿',
    variant: 'outline',
  },
  pending: {
    label: '处理中',
    variant: 'secondary',
  },
  failed: {
    label: '失败',
    variant: 'destructive',
  },
  succeeded: {
    label: '已完成',
    variant: 'default',
  },
  active: {
    label: '已激活',
    variant: 'default',
  },
  enabled: {
    label: '已启用',
    variant: 'default',
  },
  disabled: {
    label: '已停用',
    variant: 'secondary',
  },
} as const;

const unknownStatus = {
  label: '状态未知',
  variant: 'outline',
} as const;

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = Object.hasOwn(statusConfig, status) ? statusConfig[status as keyof typeof statusConfig] : unknownStatus;
  const { label, variant } = config;

  return (
    <Badge aria-label={`状态：${label}`} data-status={status} variant={variant}>
      {label}
    </Badge>
  );
}
