export const PLATFORM_THEME_KEY = 'range-platform-theme';

export type PlatformTheme = 'classic' | 'cel';

// Runs before the first paint, including on a reload of a different route.
export const initializePlatformTheme = "try { if (localStorage.getItem('" + PLATFORM_THEME_KEY + "') === 'cel') document.documentElement.dataset.platformTheme = 'cel'; } catch {}";
