'use client';

import { type ReactNode } from 'react';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type AdminListToolbarView = {
  value: string;
  label: string;
};

interface AdminListToolbarBaseProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  children: ReactNode;
  action?: ReactNode;
  searchControls?: ReactNode;
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
    <div className={compact ? 'relative w-full sm:w-44' : 'relative w-full sm:max-w-xs'}>
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
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {search}
      {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
    </div>
  );
}

export function AdminListToolbar(props: AdminListToolbarProps) {
  const search = (
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0" data-testid="admin-list-toolbar-search-controls">
      <SearchField {...props} compact={Boolean(props.searchControls)} />
      {props.searchControls}
    </div>
  );

  if (props.views) {
    return (
      <Tabs className="gap-3" onValueChange={props.onViewChange} value={props.activeView}>
        <ToolbarLayout
          controls={
            <>
              <TabsList aria-label={`${props.searchLabel}视图`} variant="line">
                {props.views.map((view) => (
                  <TabsTrigger key={view.value} value={view.value}>
                    {view.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="flex min-w-[6.75rem] justify-end" data-testid="admin-list-toolbar-view-action">
                {props.action}
              </div>
            </>
          }
          search={search}
        />
        <TabsContent className="admin-list-toolbar-panel" value={props.activeView}>
          {props.children}
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <>
      <ToolbarLayout controls={props.action} search={search} />
      {props.children}
    </>
  );
}
