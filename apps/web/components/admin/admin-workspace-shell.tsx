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
  { href: '/admin', label: '靶场总览' },
  { href: '/admin/range-instances', label: '靶场实例' },
  { href: '/admin/provision-jobs', label: '编排任务' },
  { href: '/admin/settings', label: '基础配置' },
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
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在恢复后台会话...</h2>
          <p className="admin-empty">请稍候，正在校验管理员登录状态。</p>
        </section>
      </main>
    );
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <p>综合靶场平台</p>
          <strong>管理后台</strong>
        </div>

        <nav className="admin-nav">
          {navigationItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isNavigationItemActive(pathname, item.href) ? 'admin-nav-link active' : 'admin-nav-link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="admin-main-shell">
        <header className="admin-topbar">
          <div>
            <p className="admin-topbar-eyebrow">靶场编排与运维控制台</p>
            <strong>当前环境：本地开发</strong>
          </div>

          <button
            type="button"
            onClick={() => {
              session.logout();
              router.replace('/admin/login');
            }}
          >
            退出登录
          </button>
        </header>

        <section className="admin-main-content">{children}</section>
      </div>
    </div>
  );
}
