import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_PLATFORM_THEME, initializePlatformTheme } from '@/lib/platform-theme';

import './globals.css';
import './cel-theme.css';

export const metadata: Metadata = {
  title: '云上综合靶场平台',
  description: '面向内部安全演练管理员的云上综合靶场编排与实例管理平台',
  icons: {
    icon: [
      {
        url: '/platform-favicon.svg?v=cel-v1',
        type: 'image/svg+xml',
        sizes: 'any',
      },
    ],
    shortcut: '/platform-favicon.svg?v=cel-v1',
  },
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN" data-platform-theme={DEFAULT_PLATFORM_THEME} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: initializePlatformTheme }} /></head>
      <body>{children}</body>
    </html>
  );
}
