'use client';

import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

import { resolveAdminApiBaseUrl } from '../../lib/admin-api-base-url';
import { AdminContentTransition } from './admin-content-transition';

const loading = () => <div aria-busy="true" className="admin-workbench-surface min-h-48"><span className="sr-only">正在加载工作台</span></div>;

function deferAdminScreen<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let resolved: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;

  return function DeferredAdminScreen(props: Props) {
    const [Screen, setScreen] = useState(() => resolved);
    const [failure, setFailure] = useState<{ error: unknown } | null>(null);

    useEffect(() => {
      if (Screen) return;
      let current = true;
      pending ??= load().then(component => resolved = component, error => { pending = null; throw error; });
      // Show the ready screen immediately; the shell already provides the loading frame.
      void pending.then(component => { if (current) setScreen(() => component); }, error => { if (current) setFailure({ error }); });
      return () => { current = false; };
    }, [Screen]);

    if (failure) throw failure.error;
    return Screen ? <Screen {...props} /> : loading();
  };
}

// Retain mounted page state without bundling every workspace into the common shell.
const retainedScreens = {
  '/admin/image-center': deferAdminScreen(() => import('./image-center-screen').then(module => module.ImageCenterScreen)),
  '/admin/instances': deferAdminScreen(() => import('./single-instances-screen').then(module => module.SingleInstancesScreen)),
  '/admin/scenarios': deferAdminScreen(() => import('./templates-screen').then(module => module.TemplatesScreen)),
  '/admin/ranges': deferAdminScreen(() => import('./range-instances-screen').then(module => module.RangeInstancesScreen)),
  '/admin/users': deferAdminScreen(() => import('./users-screen').then(module => module.UsersScreen)),
  '/admin/billing': deferAdminScreen(() => import('./billing-screen').then(module => module.BillingScreen)),
  '/admin/settings/cloud': deferAdminScreen(() => import('./settings/settings-screen').then(module => module.SettingsScreen)),
};
const rangeDetailRoute = /^\/admin\/ranges\/([^/]+)$/;
const templateEditorRoute = /^\/admin\/scenarios\/[^/]+$/;
const RangeInstanceDetailScreen = deferAdminScreen(() => import('./range-instance-detail-screen').then(module => module.RangeInstanceDetailScreen));

const AdminRouteActivityContext = createContext<string | null | undefined>(undefined);

function isRetainedAdminRoute(pathname: string) {
  return pathname !== '/admin/scenarios/new' &&
    (Object.hasOwn(retainedScreens, pathname) || rangeDetailRoute.test(pathname) || templateEditorRoute.test(pathname));
}

function createRetainedAdminPage(pathname: string) {
  const apiBaseUrl = resolveAdminApiBaseUrl();
  const Screen = retainedScreens[pathname as keyof typeof retainedScreens];
  if (Screen) return <Screen apiBaseUrl={apiBaseUrl} />;
  const range = rangeDetailRoute.exec(pathname);
  if (!range?.[1]) return null;
  // The router's child slot is recreated on navigation; retain the detail controller by ID.
  try {
    return <RangeInstanceDetailScreen apiBaseUrl={apiBaseUrl} rangeId={decodeURIComponent(range[1])} />;
  } catch {
    return null;
  }
}

export function useAdminRouteIsActive(pathname: string) {
  const routeActivity = useContext(AdminRouteActivityContext);

  return routeActivity === undefined || routeActivity === pathname;
}

const RetainedAdminPage = memo(function RetainedAdminPage({ route, active, page }: {
  route: string;
  active: boolean;
  page: ReactNode;
}) {
  return (
    <AdminRouteActivityContext.Provider value={active ? route : null}>
      <AdminContentTransition hidden={!active} pathname={route} testId={active ? 'admin-content-transition' : null}>
        {page}
      </AdminContentTransition>
    </AdminRouteActivityContext.Provider>
  );
});

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
    <>
      {[...retainedPagesRef.current.entries()].map(([route, page]) => (
        <RetainedAdminPage active={route === pathname} key={route} route={route} page={page} />
      ))}
      {!isRetainedAdminRoute(pathname) ? (
        <RetainedAdminPage active key={pathname} route={pathname} page={children} />
      ) : null}
    </>
  );
}
