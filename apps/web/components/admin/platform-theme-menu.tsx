'use client';

import { Palette } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DEFAULT_PLATFORM_THEME, PLATFORM_THEME_KEY, type PlatformTheme } from '@/lib/platform-theme';

const themeEvent = 'range-platform-theme-change';

function getTheme(): PlatformTheme {
  return document.documentElement.dataset.platformTheme === 'cel' ? 'cel' : 'classic';
}

function applyTheme(theme: PlatformTheme) {
  if (theme === 'cel') document.documentElement.dataset.platformTheme = 'cel';
  else delete document.documentElement.dataset.platformTheme;
}

function setTheme(theme: PlatformTheme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(PLATFORM_THEME_KEY, theme);
  } catch {
    // The theme can still change when storage is unavailable.
  }
  window.dispatchEvent(new Event(themeEvent));
}

function subscribe(listener: () => void) {
  function syncStorage(event: StorageEvent) {
    if (event.key !== PLATFORM_THEME_KEY && event.key !== null) return;
    applyTheme(event.newValue === 'classic' ? 'classic' : DEFAULT_PLATFORM_THEME);
    listener();
  }

  window.addEventListener(themeEvent, listener);
  window.addEventListener('storage', syncStorage);
  return () => {
    window.removeEventListener(themeEvent, listener);
    window.removeEventListener('storage', syncStorage);
  };
}

export function usePlatformTheme() {
  return useSyncExternalStore<PlatformTheme>(subscribe, getTheme, () => DEFAULT_PLATFORM_THEME);
}

export function PlatformThemeMenu() {
  const theme = usePlatformTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="切换主题" size="sm" type="button" variant="outline">
          <Palette aria-hidden="true" />主题
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="平台主题">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value === 'cel' ? 'cel' : 'classic')}>
          <DropdownMenuRadioItem value="classic">经典</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cel">赛璐璐</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
