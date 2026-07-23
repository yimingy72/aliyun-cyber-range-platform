'use client';

import { type ReactNode } from 'react';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface ListToolbarProps {
  searchValue: string;
  activeView: 'mine' | 'platform';
  onSearchChange: (value: string) => void;
  onViewChange: (view: 'mine' | 'platform') => void;
  children: ReactNode;
}

function isTemplateView(value: string): value is ListToolbarProps['activeView'] {
  return value === 'mine' || value === 'platform';
}

export function ListToolbar({ searchValue, activeView, onSearchChange, onViewChange, children }: ListToolbarProps) {
  return (
    <Tabs
      className="gap-3"
      onValueChange={(value) => {
        if (isTemplateView(value)) {
          onViewChange(value);
        }
      }}
      value={activeView}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="筛选靶场名"
            className="pl-8"
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="筛选靶场名"
            type="search"
            value={searchValue}
          />
        </div>
        <TabsList aria-label="靶场编排视图">
          <TabsTrigger value="mine">我的拓扑</TabsTrigger>
          <TabsTrigger value="platform">平台拓扑</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value={activeView}>{children}</TabsContent>
    </Tabs>
  );
}
