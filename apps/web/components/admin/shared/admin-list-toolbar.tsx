'use client';

import { type ReactNode } from 'react';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { usePlatformTheme } from '../platform-theme-menu';
import { AdminWorkbenchControls } from './admin-workbench-controls';
import { AdminWorkbenchIcon, type WorkbenchIconProps } from './admin-workbench-icon';

export type AdminListToolbarView = {
  value: string;
  label: string;
  celIcon?: WorkbenchIconProps;
};

interface AdminListToolbarBaseProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  children: ReactNode;
  action?: ReactNode;
  searchControls?: ReactNode;
  compactViewAction?: boolean;
  listTitle?: string;
  celViewsInBand?: boolean;
  celHeadingControls?: ReactNode;
}

type AdminListToolbarProps =
  | (AdminListToolbarBaseProps & {
      views: AdminListToolbarView[];
      activeView: string;
      onViewChange: (view: string) => void;
    })
  | (AdminListToolbarBaseProps & {
      views?: undefined;
      activeView?: undefined;
      onViewChange?: undefined;
    });

function SearchField({
  searchLabel,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  compact,
}: Pick<AdminListToolbarBaseProps, 'searchLabel' | 'searchPlaceholder' | 'searchValue' | 'onSearchChange'> & {
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'relative w-full sm:w-60' : 'relative w-full sm:max-w-xs'}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={searchLabel}
        className="pl-8"
        onChange={(event) => onSearchChange(event.currentTarget.value)}
        placeholder={searchPlaceholder}
        type="search"
        value={searchValue}
      />
    </div>
  );
}

function ToolbarLayout({ search, controls }: { search: ReactNode; controls?: ReactNode }) {
  const actions = controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {search}
      {actions}
    </div>
  );
}

export function AdminListToolbar(props: AdminListToolbarProps) {
  const isCel = usePlatformTheme() === 'cel';
  const search = (
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0" data-testid="admin-list-toolbar-search-controls">
      <SearchField {...props} compact={Boolean(props.searchControls)} />
      {props.searchControls}
    </div>
  );

  if (props.views) {
    const views = (
      <TabsList aria-label={props.searchLabel + '视图'} variant="line">
        {props.views.map(({ value, label, celIcon }) => (
          <TabsTrigger key={value} value={value}>
            {isCel && props.celViewsInBand && celIcon && <AdminWorkbenchIcon {...celIcon} />}
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    );
    const actions = props.action ? (
      <div className={cn('flex shrink-0', props.compactViewAction ? 'justify-start' : 'w-36 justify-end')}
        data-testid="admin-list-toolbar-view-action">{props.action}</div>
    ) : null;
    return (
      <Tabs className="min-h-0 flex-1 gap-3" onValueChange={props.onViewChange} value={props.activeView}>
        {isCel ? <>
          {props.celViewsInBand && <div className="cel-source-tabs">{views}</div>}
          <AdminWorkbenchControls title={props.listTitle}
            views={props.celViewsInBand ? props.celHeadingControls : views} actions={actions} filters={search} />
        </> : <ToolbarLayout controls={<>{views}{actions}</>} search={search} />}
        <TabsContent className="admin-list-toolbar-panel flex min-h-0 flex-1 flex-col" value={props.activeView}>
          {props.children}
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <>
      {isCel ? <AdminWorkbenchControls title={props.listTitle} actions={props.action} filters={search} /> : <ToolbarLayout controls={props.action} search={search} />}
      {props.children}
    </>
  );
}
