import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: '云上综合靶场平台',
  description: '面向内部安全演练管理员的云上综合靶场编排与实例管理平台',
  icons: {
    icon: [
      {
        url: '/platform-favicon.ico?v=shield-v1',
        type: 'image/x-icon',
        sizes: 'any',
      },
    ],
    shortcut: '/platform-favicon.ico?v=shield-v1',
  },
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
