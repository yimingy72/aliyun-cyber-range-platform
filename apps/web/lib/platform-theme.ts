export const PLATFORM_THEME_KEY = 'range-platform-theme';

export const PLATFORM_THEMES = {
  classic: '经典',
  cel: '赛璐璐',
  'data-dense': '数据密集',
} as const;

export type PlatformTheme = keyof typeof PLATFORM_THEMES;

export const DEFAULT_PLATFORM_THEME: PlatformTheme = 'cel';

// Runs before the first paint, including on a reload of a different route.
export const initializePlatformTheme = `try {
  const savedTheme = localStorage.getItem('${PLATFORM_THEME_KEY}');
  if (savedTheme === 'classic') delete document.documentElement.dataset.platformTheme;
  else if (savedTheme === 'data-dense') document.documentElement.dataset.platformTheme = savedTheme;
} catch {}`;

export function resolvePlatformTheme(value?: string | null): PlatformTheme {
  return value && Object.hasOwn(PLATFORM_THEMES, value) ? value as PlatformTheme : DEFAULT_PLATFORM_THEME;
}
