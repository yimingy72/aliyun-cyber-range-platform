'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';

import { resolveAdminApiBaseUrl } from '../../lib/admin-api-base-url';
import { AdminContentTransition } from './admin-content-transition';
import { BillingScreen } from './billing-screen';
import { ImageCenterScreen } from './image-center-screen';
import { RangeInstancesScreen } from './range-instances-screen';
import { SettingsScreen } from './settings/settings-screen';
import { SingleInstancesScreen } from './single-instances-screen';
import { TemplatesScreen } from './templates-screen';
import { UsersScreen } from './users-screen';

const RETAINED_ADMIN_ROUTES = new Set([
  '/admin/image-center',
  '/admin/instances',
  '/admin/scenarios',
  '/admin/ranges',
  '/admin/users',
  '/admin/billing',
  '/admin/settings/cloud',
]);
const RETAINED_ADMIN_DYNAMIC_ROUTE_PATTERNS = [/^\/admin\/scenarios\/[^/]+$/, /^\/admin\/ranges\/[^/]+$/];

type AdminRouteActivityContextValue = {
  pathname: string;
};

const AdminRouteActivityContext = createContext<AdminRouteActivityContextValue | null>(null);

function isRetainedAdminRoute(pathname: string) {
  return RETAINED_ADMIN_ROUTES.has(pathname) || RETAINED_ADMIN_DYNAMIC_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function createRetainedAdminPage(pathname: string) {
  const apiBaseUrl = resolveAdminApiBaseUrl();

  switch (pathname) {
    case '/admin/image-center':
      return <ImageCenterScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/instances':
      return <SingleInstancesScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/scenarios':
      return <TemplatesScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/ranges':
      return <RangeInstancesScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/users':
      return <UsersScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/billing':
      return <BillingScreen apiBaseUrl={apiBaseUrl} />;
    case '/admin/settings/cloud':
      return <SettingsScreen apiBaseUrl={apiBaseUrl} />;
    default:
      return null;
  }
}

export function useAdminRouteIsActive(pathname: string) {
  const routeActivity = useContext(AdminRouteActivityContext);

  return routeActivity ? routeActivity.pathname === pathname : true;
}

export type AdminPageCacheProps = {
  pathname: string;
  children: ReactNode;
  createPage?: (pathname: string) => ReactNode | null;
};

export function AdminPageCache({
  pathname,
  children,
  createPage = createRetainedAdminPage,
}: AdminPageCacheProps) {
  const retainedPagesRef = useRef(new Map<string, ReactNode>());
  const scrollPositionsRef = useRef(new Map<string, number>());

  if (isRetainedAdminRoute(pathname) && !retainedPagesRef.current.has(pathname)) {
    retainedPagesRef.current.set(pathname, createPage(pathname) ?? children);
  }

  useEffect(() => {
    const scrollContainer = document.querySelector<HTMLElement>('.admin-main-content');

    if (!scrollContainer) {
      return;
    }

    const rememberScrollPosition = () => {
      scrollPositionsRef.current.set(pathname, scrollContainer.scrollTop);
    };

    rememberScrollPosition();
    scrollContainer.addEventListener('scroll', rememberScrollPosition, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', rememberScrollPosition);
    };
  }, [pathname]);

  useLayoutEffect(() => {
    const scrollContainer = document.querySelector<HTMLElement>('.admin-main-content');

    if (!scrollContainer) {
      return;
    }

    scrollContainer.scrollTop = scrollPositionsRef.current.get(pathname) ?? 0;
  }, [pathname]);

  return (
    <AdminRouteActivityContext.Provider value={{ pathname }}>
      {[...retainedPagesRef.current.entries()].map(([route, page]) => (
        <AdminContentTransition
          hidden={route !== pathname}
          key={route}
          pathname={route}
          testId={route === pathname ? 'admin-content-transition' : null}
        >
          {page}
        </AdminContentTransition>
      ))}
      {!isRetainedAdminRoute(pathname) ? (
        <AdminContentTransition pathname={pathname}>{children}</AdminContentTransition>
      ) : null}
    </AdminRouteActivityContext.Provider>
  );
}
