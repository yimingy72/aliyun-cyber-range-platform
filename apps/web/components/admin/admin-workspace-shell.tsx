'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  parseAdminOidcSessionPayload,
  readAdminOidcTokenExpiresAt,
  refreshAdminOidcToken,
} from '../../lib/admin-oidc';
import { resolveAdminOidcClientId, resolveAdminOidcIssuer } from '../../lib/admin-oidc-config';
import { writeAdminSession } from '../../lib/admin-auth-storage';
import { useAdminSession } from './use-admin-session';

type AdminWorkspaceShellProps = {
  children: ReactNode;
};

const navigationItems = [
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
];

const userManagementNavigationItem = {
  href: '/admin/users',
  label: '用户管理',
  shortLabel: '用户',
};

const billingNavigationItem = {
  href: '/admin/billing',
  label: '账单费用',
  shortLabel: '账单',
};

const cloudSettingsNavigationItem = {
  href: '/admin/settings/cloud',
  label: '基础配置',
  shortLabel: '配置',
};

const SESSION_REFRESH_BUFFER_MS = 60_000;

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
  const oidcIssuer = resolveAdminOidcIssuer();
  const oidcClientId = resolveAdminOidcClientId();
  const isLoginRoute = pathname === '/admin/login';
  const isCallbackRoute = pathname === '/admin/callback';
  const [isRenewingSession, setIsRenewingSession] = useState(false);
  const renewalTimeoutRef = useRef<number | null>(null);
  const renewingRef = useRef(false);
  const visibleNavigationItems = session.isAdmin
    ? [...navigationItems, userManagementNavigationItem, billingNavigationItem, cloudSettingsNavigationItem]
    : navigationItems;
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
    return null;
  }

  if (isRenewingSession || shouldRenewNow) {
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
          {visibleNavigationItems.map((item) => (
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
            {session.profile ? (
              <div className="admin-topbar-badge-group" aria-label="当前登录用户">
                <span className="admin-topbar-badge">
                  {session.profile.username} / {session.profile.role}
                </span>
              </div>
            ) : null}
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
