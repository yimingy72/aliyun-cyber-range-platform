import { type ReactNode } from 'react';

interface AdminPageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function AdminPageHeader({ title, description, action }: AdminPageHeaderProps) {
  return (
    <header
      className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between"
      data-slot="admin-page-header"
    >
      <div className="min-w-0">
        <h1 className="font-heading text-xl font-semibold text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end" data-slot="admin-page-header-actions">
          {action}
        </div>
      ) : null}
    </header>
  );
}
