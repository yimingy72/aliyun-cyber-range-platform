'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAdminSession } from './use-admin-session';

type AdminWorkspaceShellProps = {
  children: ReactNode;
};

const navigationItems = [
  {
    href: '/admin/scenarios',
    label: '靶场编排',
    shortLabel: '编排',
  },
  {
    href: '/admin/ranges',
    label: '靶场实例',
    shortLabel: '实例',
  },
  {
    href: '/admin/image-center',
    label: '镜像中心',
    shortLabel: '镜像',
  },
  {
    href: '/admin/settings/cloud',
    label: '基础配置',
    shortLabel: '配置',
  },
];

function isNavigationItemActive(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminWorkspaceShell({ children }: AdminWorkspaceShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAdminSession();
  const isLoginRoute = pathname === '/admin/login';

  useEffect(() => {
    if (!isLoginRoute && session.isReady && !session.token) {
      router.replace('/admin/login');
    }
  }, [isLoginRoute, router, session.isReady, session.token]);

  if (isLoginRoute) {
    return <>{children}</>;
  }

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <div className="admin-brand-copy">
            <strong>综合靶场平台</strong>
          </div>
        </div>

        <nav className="admin-nav">
          {navigationItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isNavigationItemActive(pathname, item.href) ? 'admin-nav-link active' : 'admin-nav-link'}
            >
              <span className="admin-nav-link-kicker">{item.shortLabel}</span>
              <strong className="admin-nav-link-label">{item.label}</strong>
            </Link>
          ))}
        </nav>
      </aside>

      <div className="admin-main-shell">
        <header className="admin-topbar admin-topbar-compact">
          <div className="admin-topbar-meta">
            <button
              type="button"
              onClick={() => {
                session.logout();
                router.replace('/admin/login');
              }}
            >
              退出登录
            </button>
          </div>
        </header>

        <div className="admin-main-content-shell">
          <section className="admin-main-content">{children}</section>
        </div>
      </div>
    </div>
  );
}
