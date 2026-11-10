'use client';

import type { ReactNode } from 'react';
import { Activity, AlertTriangle, Layers } from 'lucide-react';

import { usePlatformTheme } from '../platform-theme-menu';
import { AdminWorkbenchIcon } from './admin-workbench-icon';

const overviewIcons = { green: Activity, blue: Layers, red: AlertTriangle };

type OverviewMetric = {
  label: string;
  value?: number | null;
  tone: keyof typeof overviewIcons;
  onClick?: () => void;
  pressed?: boolean;
};

interface AdminPageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  artwork?: 'images' | 'instances' | 'scenarios' | 'ranges' | 'users' | 'billing' | 'settings';
  overview?: {
    label?: string;
    listTitle?: string;
    metrics: readonly OverviewMetric[];
  };
}

export function AdminPageHeader({ title, description, action, artwork, overview }: AdminPageHeaderProps) {
  const theme = usePlatformTheme();
  const isCel = theme === 'cel';
  const workbench = theme !== 'classic' ? overview : undefined;

  return (
    <>
      <header
        className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between"
        data-cel-workbench={isCel && (artwork || overview) ? '' : undefined}
        data-cel-artwork={isCel ? artwork : undefined}
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
      {workbench && <>
        <div className="cel-workbench-overview" role="group" aria-label={workbench.label ?? title + '概览'}>
          {workbench.metrics.map(({ label, value, tone, onClick, pressed }) => {
            const content = <><AdminWorkbenchIcon icon={overviewIcons[tone]} tone={tone} />{label}<strong>{value == null ? '—' : String(value).padStart(2, '0')}</strong></>;
            return onClick
              ? <button aria-pressed={pressed} data-tone={tone} key={label} onClick={onClick} type="button">{content}</button>
              : <div data-tone={tone} key={label}>{content}</div>;
          })}
        </div>
        {workbench.listTitle && <h2 className="cel-workbench-list-title">{workbench.listTitle}</h2>}
      </>}
    </>
  );
}
