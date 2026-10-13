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
  buildAdminOidcLogoutUrl,
  clearPendingAdminOidcLogin,
  parseAdminOidcSessionPayload,
  readAdminOidcTokenExpiresAt,
  refreshAdminOidcToken,
} from '../../lib/admin-oidc';
import { resolveAdminOidcClientId, resolveAdminOidcIssuer } from '../../lib/admin-oidc-config';
import {
  invalidateAdminSessionForLogout,
  readAdminSession,
  writeAdminSession,
} from '../../lib/admin-auth-storage';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';
import { AdminPageCache } from './admin-page-cache';
import { AdminWorkspaceLoadingState } from './admin-workspace-loading-state';
import { PlatformBrand } from './platform-brand';
import { useAdminSession } from './use-admin-session';
import { fetchAuthenticatedAdminProfile } from '@/lib/admin-api';
import { resolveAdminApiBaseUrl } from '@/lib/admin-api-base-url';
import { CloudWorkspaceProvider, cloudProviderLabel, useCloudWorkspace } from './cloud-workspace-provider';

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
  onNavigate: (href: string) => void;
  pathname: string;
  pendingHref: string | null;
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
  { href: '/admin/resource-alerts', label: '资源告警', shortLabel: '告警', requiresAdmin: true },
];

const SESSION_REFRESH_BUFFER_MS = 60_000;

function isNavigationItemActive(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function AdminNavigation({ items, onNavigate, pathname, pendingHref, className }: AdminNavigationProps) {
  return (
    <nav aria-label="后台导航" className={cn('grid content-start gap-1.5', className)}>
      {items.map((item) => {
        const isActive = isNavigationItemActive(pathname, item.href);
        const isPending = pendingHref === item.href;

        return (
          <Link
            key={item.href}
            aria-busy={isPending || undefined}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-h-10 items-center gap-3 rounded-md border border-transparent px-2.5 py-2 text-sm transition-[background-color,border-color,color,transform] duration-150 active:translate-y-px',
              isActive
                ? 'border-[#dbe6f8] bg-[#eaf1ff] text-[#1d56a7]'
                : 'text-[#32425d] hover:border-[#ebf0f6] hover:bg-[#f7f9fc]',
              isPending && 'pointer-events-none opacity-75',
            )}
            data-pending={isPending || undefined}
            href={item.href}
            scroll={false}
            onClick={(event) => {
              if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
              }

              onNavigate(item.href);
            }}
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
  if (pathname === '/admin/login' || pathname === '/admin/callback') return <AdminWorkspaceShellContent>{children}</AdminWorkspaceShellContent>;
  return <CloudWorkspaceProvider><AdminWorkspaceShellContent>{children}</AdminWorkspaceShellContent></CloudWorkspaceProvider>;
}

function AdminWorkspaceShellContent({ children }: AdminWorkspaceShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAdminSession();
  const cloudWorkspace = useCloudWorkspace();
  const oidcIssuer = resolveAdminOidcIssuer();
  const oidcClientId = resolveAdminOidcClientId();
  const isLoginRoute = pathname === '/admin/login';
  const isCallbackRoute = pathname === '/admin/callback';
  const isTopologyEditorRoute = /^\/admin\/scenarios\/[^/]+$/.test(pathname);
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [isRenewingSession, setIsRenewingSession] = useState(false);
  const renewalTimeoutRef = useRef<number | null>(null);
  const renewingRef = useRef(false);
  const loggingOutRef = useRef(false);
  const hasRenderedWorkspaceRef = useRef(false);
  const visibleNavigationItems = navigationItems.filter((item) => !item.requiresAdmin || session.isAdmin);
  const tokenExpiresAt = session.token ? readAdminOidcTokenExpiresAt(session.token) : null;
  const shouldRenewNow = Boolean(
    session.token &&
      session.refreshToken &&
      tokenExpiresAt !== null &&
      tokenExpiresAt - Date.now() <= SESSION_REFRESH_BUFFER_MS,
  );

  async function renewSession() {
    if (loggingOutRef.current || renewingRef.current || !session.refreshToken) {
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

      if (loggingOutRef.current) {
        return;
      }

      if (!nextSession) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      const currentSession = readAdminSession();
      if (!currentSession || currentSession.refreshToken !== session.refreshToken) {
        return;
      }

      const profile = await fetchAuthenticatedAdminProfile(resolveAdminApiBaseUrl(), nextSession.token);
      if (loggingOutRef.current || readAdminSession()?.refreshToken !== session.refreshToken) return;

      writeAdminSession({
        ...nextSession,
        profile,
        idToken: nextSession.idToken ?? currentSession.idToken,
        refreshToken: nextSession.refreshToken ?? currentSession.refreshToken,
        sessionGeneration: currentSession.sessionGeneration,
      });
    } catch {
      if (!loggingOutRef.current) {
        session.logout();
        router.replace('/admin/login');
      }
    } finally {
      renewingRef.current = false;
      setIsRenewingSession(false);
    }
  }

  useEffect(() => {
    if (
      !loggingOutRef.current &&
      !isLoginRoute &&
      !isCallbackRoute &&
      session.isReady &&
      !session.token &&
      !isRenewingSession
    ) {
      router.replace('/admin/login');
    }
  }, [isCallbackRoute, isLoginRoute, isRenewingSession, router, session.isReady, session.token]);

  useEffect(() => {
    setPendingHref((current) => (current && isNavigationItemActive(pathname, current) ? null : current));
  }, [pathname]);

  function handleNavigate(href: string) {
    setIsNavigationOpen(false);

    if (!isNavigationItemActive(pathname, href)) {
      setPendingHref(href);
    }
  }

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

  function logoutFromPlatform() {
    if (loggingOutRef.current) {
      return;
    }

    loggingOutRef.current = true;
    const logoutUrl = buildAdminOidcLogoutUrl({
      issuer: oidcIssuer,
      clientId: oidcClientId,
      postLogoutRedirectUri: `${window.location.origin}/admin/login`,
      idTokenHint: session.idToken,
    });

    invalidateAdminSessionForLogout();
    clearPendingAdminOidcLogin();
    window.location.assign(logoutUrl);
  }

  if (isLoginRoute || isCallbackRoute) {
    return <>{children}</>;
  }

  if (!session.isReady) {
    return <AdminWorkspaceLoadingState label="正在恢复管理会话" />;
  }

  if ((isRenewingSession || shouldRenewNow) && !hasRenderedWorkspaceRef.current) {
    return <AdminWorkspaceLoadingState label="正在续期管理会话" />;
  }

  if (!session.token) {
    hasRenderedWorkspaceRef.current = false;
    return null;
  }

  hasRenderedWorkspaceRef.current = true;

  return (
    <div
      className="admin-workspace"
      data-topology-editor={isTopologyEditorRoute ? 'true' : undefined}
    >
      <aside className="admin-sidebar bg-card text-card-foreground">
        <div className="border-b border-border px-5 py-[18px]" data-testid="admin-sidebar-brand">
          <PlatformBrand />
        </div>
        <AdminNavigation
          className="px-3 pb-4"
          items={visibleNavigationItems}
          onNavigate={handleNavigate}
          pathname={pathname}
          pendingHref={pendingHref}
        />
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
                  <SheetTitle className="leading-none">
                    <PlatformBrand compact />
                  </SheetTitle>
                </SheetHeader>
                <AdminNavigation
                  className="px-3 py-4"
                  items={visibleNavigationItems}
                  onNavigate={handleNavigate}
                  pathname={pathname}
                  pendingHref={pendingHref}
                />
              </SheetContent>
            </Sheet>

            {cloudWorkspace?.workspace ? <div className="flex min-w-0 max-w-[48%] items-center gap-2 text-xs text-muted-foreground" aria-label="当前云账号工作空间">
              <span className="shrink-0 font-semibold text-foreground">{cloudProviderLabel(cloudWorkspace.workspace.provider)}</span>
              <span className="hidden truncate sm:inline" title={cloudWorkspace.workspace.displayName}>{cloudWorkspace.workspace.displayName} · {cloudWorkspace.workspace.accountUid ?? '历史数据'}</span>
            </div> : null}
            <div className="admin-topbar-meta ml-auto">
              {isRenewingSession ? <span role="status">正在续期管理会话</span> : null}
              {session.profile ? (
                <div className="admin-topbar-badge-group" aria-label="当前登录用户">
                  <span className="admin-topbar-badge">
                    {session.profile.username} / {session.profile.role}
                  </span>
                </div>
              ) : null}
              <Button
                onClick={logoutFromPlatform}
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
          <section className="admin-main-content">
            {cloudWorkspace && !cloudWorkspace.isReady ? <div className="admin-workbench-surface min-h-48" aria-busy={!cloudWorkspace.error}>
              {cloudWorkspace.error ? <div className="grid gap-4"><p role="alert" className="text-sm text-destructive">{cloudWorkspace.error}</p><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={cloudWorkspace.retry}>重新加载工作空间</Button><Button variant="outline" onClick={cloudWorkspace.resetSelection}>使用登录账号默认工作空间</Button></div></div> : <span className="sr-only">正在恢复云账号工作空间</span>}
            </div> : cloudWorkspace && !cloudWorkspace.workspace && pathname !== '/admin/settings/cloud' ? <div className="admin-workbench-surface"><p className="text-sm">尚未绑定云账号工作空间。</p>{session.profile?.isPlatformManager ? <Link className="mt-4 inline-block text-sm text-primary" href="/admin/settings/cloud">前往基础配置绑定云账号</Link> : null}</div> :
            <AdminScreenCacheProvider key={`${session.profile?.id}:${cloudWorkspace?.workspace?.id ?? ''}:${cloudWorkspace?.workspace?.activeCloudAccountContextId ?? ''}`}>
              <AdminPageCache pathname={pathname}>{children}</AdminPageCache>
            </AdminScreenCacheProvider>}
          </section>
        </div>
      </div>
    </div>
  );
}
