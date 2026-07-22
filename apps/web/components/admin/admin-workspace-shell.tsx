'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MenuIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  parseAdminOidcSessionPayload,
  readAdminOidcTokenExpiresAt,
  refreshAdminOidcToken,
} from '../../lib/admin-oidc';
import { resolveAdminOidcClientId, resolveAdminOidcIssuer } from '../../lib/admin-oidc-config';
import { writeAdminSession } from '../../lib/admin-auth-storage';
import { AdminWorkspaceLoadingState } from './admin-workspace-loading-state';
import { useAdminSession } from './use-admin-session';

type AdminWorkspaceShellProps = {
  children: ReactNode;
};

interface AdminNavigationItem {
  href: string;
  label: string;
  shortLabel: string;
  requiresAdmin?: boolean;
}

type AdminNavigationProps = {
  items: readonly AdminNavigationItem[];
  onNavigate?: () => void;
  pathname: string;
  className?: string;
};

const navigationItems: readonly AdminNavigationItem[] = [
  {
    href: '/admin/image-center',
    label: '镜像中心',
    shortLabel: '镜像',
  },
  {
    href: '/admin/instances',
    label: '实例管理',
    shortLabel: '实例',
  },
  {
    href: '/admin/scenarios',
    label: '靶场编排',
    shortLabel: '编排',
  },
  {
    href: '/admin/ranges',
    label: '编排实例',
    shortLabel: '实例',
  },
  {
    href: '/admin/users',
    label: '用户管理',
    shortLabel: '用户',
    requiresAdmin: true,
  },
  {
    href: '/admin/billing',
    label: '账单费用',
    shortLabel: '账单',
    requiresAdmin: true,
  },
  {
    href: '/admin/settings/cloud',
    label: '基础配置',
    shortLabel: '配置',
    requiresAdmin: true,
  },
];

const SESSION_REFRESH_BUFFER_MS = 60_000;

function isNavigationItemActive(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function AdminNavigation({ items, onNavigate, pathname, className }: AdminNavigationProps) {
  return (
    <nav aria-label="后台导航" className={cn('grid content-start gap-1.5', className)}>
      {items.map((item) => {
        const isActive = isNavigationItemActive(pathname, item.href);

        return (
          <Link
            key={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-h-10 items-center gap-3 rounded-md border border-transparent px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'border-[#dbe6f8] bg-[#eaf1ff] text-[#1d56a7]'
                : 'text-[#32425d] hover:border-[#ebf0f6] hover:bg-[#f7f9fc]',
            )}
            href={item.href}
            onClick={() => onNavigate?.()}
          >
            <span
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-md bg-[#f0f4f9] text-[10px] font-bold text-[#4a607f]',
                isActive && 'bg-white text-[#1d56a7]',
              )}
            >
              {item.shortLabel}
            </span>
            <span className="min-w-0 font-semibold">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminWorkspaceShell({ children }: AdminWorkspaceShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAdminSession();
  const oidcIssuer = resolveAdminOidcIssuer();
  const oidcClientId = resolveAdminOidcClientId();
  const isLoginRoute = pathname === '/admin/login';
  const isCallbackRoute = pathname === '/admin/callback';
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isRenewingSession, setIsRenewingSession] = useState(false);
  const renewalTimeoutRef = useRef<number | null>(null);
  const renewingRef = useRef(false);
  const visibleNavigationItems = navigationItems.filter((item) => !item.requiresAdmin || session.isAdmin);
  const tokenExpiresAt = session.token ? readAdminOidcTokenExpiresAt(session.token) : null;
  const shouldRenewNow = Boolean(
    session.token &&
      session.refreshToken &&
      tokenExpiresAt !== null &&
      tokenExpiresAt - Date.now() <= SESSION_REFRESH_BUFFER_MS,
  );

  async function renewSession() {
    if (renewingRef.current || !session.refreshToken) {
      return;
    }

    renewingRef.current = true;
    setIsRenewingSession(true);

    try {
      const tokenResponse = await refreshAdminOidcToken({
        issuer: oidcIssuer,
        clientId: oidcClientId,
        refreshToken: session.refreshToken,
      });
      const nextSession = tokenResponse ? parseAdminOidcSessionPayload(tokenResponse) : null;

      if (!nextSession) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      writeAdminSession({
        ...nextSession,
        refreshToken: nextSession.refreshToken ?? session.refreshToken,
      });
    } catch {
      session.logout();
      router.replace('/admin/login');
    } finally {
      renewingRef.current = false;
      setIsRenewingSession(false);
    }
  }

  useEffect(() => {
    if (!isLoginRoute && !isCallbackRoute && session.isReady && !session.token && !isRenewingSession) {
      router.replace('/admin/login');
    }
  }, [isCallbackRoute, isLoginRoute, isRenewingSession, router, session.isReady, session.token]);

  useEffect(() => {
    if (renewalTimeoutRef.current !== null) {
      window.clearTimeout(renewalTimeoutRef.current);
      renewalTimeoutRef.current = null;
    }

    if (isLoginRoute || isCallbackRoute || !session.isReady || !session.token || !session.refreshToken || !tokenExpiresAt) {
      return;
    }

    if (shouldRenewNow) {
      void renewSession();
      return;
    }

    const delay = Math.max(tokenExpiresAt - Date.now() - SESSION_REFRESH_BUFFER_MS, 0);
    renewalTimeoutRef.current = window.setTimeout(() => {
      void renewSession();
    }, delay);

    const handleWindowFocus = () => {
      const currentExpiresAt = session.token ? readAdminOidcTokenExpiresAt(session.token) : null;

      if (
        session.refreshToken &&
        currentExpiresAt !== null &&
        currentExpiresAt - Date.now() <= SESSION_REFRESH_BUFFER_MS
      ) {
        void renewSession();
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('visibilitychange', handleWindowFocus);

    return () => {
      if (renewalTimeoutRef.current !== null) {
        window.clearTimeout(renewalTimeoutRef.current);
        renewalTimeoutRef.current = null;
      }

      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('visibilitychange', handleWindowFocus);
    };
  }, [
    isCallbackRoute,
    isLoginRoute,
    oidcClientId,
    oidcIssuer,
    session.isReady,
    session.refreshToken,
    session.token,
    shouldRenewNow,
    tokenExpiresAt,
  ]);

  if (isLoginRoute || isCallbackRoute) {
    return <>{children}</>;
  }

  if (!session.isReady) {
    return <AdminWorkspaceLoadingState label="正在恢复管理会话" />;
  }

  if (isRenewingSession || shouldRenewNow) {
    return <AdminWorkspaceLoadingState label="正在续期管理会话" />;
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar bg-card text-card-foreground">
        <div className="border-b border-border px-5 py-5">
          <strong className="text-sm font-semibold">综合靶场平台</strong>
        </div>
        <AdminNavigation className="px-3 pb-4" items={visibleNavigationItems} pathname={pathname} />
      </aside>

      <div className="admin-main-shell">
        <header className="admin-topbar admin-topbar-compact">
          <div className="flex w-full items-center justify-between gap-3">
            <Sheet onOpenChange={setIsNavigationOpen} open={isNavigationOpen}>
              <SheetTrigger asChild>
                <Button aria-label="打开导航" className="lg:hidden" size="icon" type="button" variant="outline">
                  <MenuIcon aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent
                className="data-[side=left]:w-[min(19rem,calc(100vw-2rem))] p-0"
                side="left"
              >
                <SheetHeader className="border-b border-border px-5 py-4">
                  <SheetTitle>综合靶场平台</SheetTitle>
                </SheetHeader>
                <AdminNavigation
                  className="px-3 py-4"
                  items={visibleNavigationItems}
                  onNavigate={() => setIsNavigationOpen(false)}
                  pathname={pathname}
                />
              </SheetContent>
            </Sheet>

            <div className="admin-topbar-meta">
              {session.profile ? (
                <div className="admin-topbar-badge-group" aria-label="当前登录用户">
                  <span className="admin-topbar-badge">
                    {session.profile.username} / {session.profile.role}
                  </span>
                </div>
              ) : null}
              <Button
                onClick={() => {
                  session.logout();
                  router.replace('/admin/login');
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                退出登录
              </Button>
            </div>
          </div>
        </header>

        <div className="admin-main-content-shell">
          <section className="admin-main-content">{children}</section>
        </div>
      </div>
    </div>
  );
}
