import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ReactNode, useEffect, useState } from 'react';

import { AdminPageCache, useAdminRouteIsActive } from './admin-page-cache';

function RetainedPage({ label }: { label: string }) {
  const [count, setCount] = useState(0);

  return (
    <button type="button" onClick={() => setCount((current) => current + 1)}>
      {label}:{count}
    </button>
  );
}

function TestAdminPageCache({ pathname, pages }: { pathname: string; pages: Record<string, ReactNode> }) {
  return (
    <AdminPageCache createPage={(route) => pages[route] ?? null} pathname={pathname}>
      {pages[pathname] ?? null}
    </AdminPageCache>
  );
}

function RouteActivityProbe({ pathname, onActive }: { pathname: string; onActive: (pathname: string) => void }) {
  const isActive = useAdminRouteIsActive(pathname);

  useEffect(() => {
    if (isActive) {
      onActive(pathname);
    }
  }, [isActive, onActive, pathname]);

  return null;
}

describe('AdminPageCache', () => {
  it('audit-ui: mounts a fresh new-template page after returning to the list', () => {
    const view = render(<TestAdminPageCache pathname="/admin/scenarios/new" pages={{
      '/admin/scenarios/new': <RetainedPage label="first draft" />,
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'first draft:0' }));
    view.rerender(<TestAdminPageCache pathname="/admin/scenarios" pages={{ '/admin/scenarios': <p>list</p> }} />);
    expect(screen.queryByText('first draft:1')).toBeNull();
    view.rerender(<TestAdminPageCache pathname="/admin/scenarios/new" pages={{
      '/admin/scenarios/new': <RetainedPage label="second draft" />,
    }} />);
    expect(screen.getByRole('button', { name: 'second draft:0' })).toBeTruthy();
    view.unmount();
  });
  it('keeps high-frequency list pages, including billing, mounted while another route is active', () => {
    const { rerender } = render(
      <TestAdminPageCache
        pathname="/admin/scenarios"
        pages={{
          '/admin/scenarios': <RetainedPage label="靶场编排" />,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '靶场编排:0' }));
    expect(screen.getByRole('button', { name: '靶场编排:1' })).toBeTruthy();

    rerender(<TestAdminPageCache pathname="/admin/billing" pages={{ '/admin/billing': <RetainedPage label="账单费用" /> }} />);

    expect(screen.getByRole('button', { name: '账单费用:0' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '账单费用:0' }));
    expect(screen.getByRole('button', { name: '账单费用:1' })).toBeTruthy();

    rerender(<TestAdminPageCache pathname="/admin/image-center" pages={{ '/admin/image-center': <RetainedPage label="镜像中心" /> }} />);

    expect(screen.getByRole('button', { name: '镜像中心:0' })).toBeTruthy();

    rerender(<TestAdminPageCache pathname="/admin/billing" pages={{ '/admin/billing': <RetainedPage label="替换账单内容" /> }} />);

    expect(screen.getByRole('button', { name: '账单费用:1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '替换账单内容:0' })).toBeNull();

    rerender(<TestAdminPageCache pathname="/admin/scenarios" pages={{ '/admin/scenarios': <RetainedPage label="替换内容" /> }} />);

    expect(screen.getByRole('button', { name: '靶场编排:1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '替换内容:0' })).toBeNull();
  });

  it('keeps dynamic detail workspaces mounted by their full admin route', () => {
    const { rerender } = render(
      <TestAdminPageCache
        pathname="/admin/scenarios/scenario-1"
        pages={{ '/admin/scenarios/scenario-1': <RetainedPage label="拓扑编辑" /> }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '拓扑编辑:0' }));

    rerender(<TestAdminPageCache pathname="/admin/users" pages={{ '/admin/users': <RetainedPage label="用户管理" /> }} />);
    expect(screen.getByRole('button', { name: '用户管理:0' })).toBeTruthy();

    rerender(
      <TestAdminPageCache
        pathname="/admin/scenarios/scenario-1"
        pages={{ '/admin/scenarios/scenario-1': <RetainedPage label="替换编辑器" /> }}
      />,
    );

    expect(screen.getByRole('button', { name: '拓扑编辑:1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '替换编辑器:0' })).toBeNull();
  });

  it('only activates effects for the visible retained route', () => {
    const activeRoutes: string[] = [];
    const onActive = (pathname: string) => activeRoutes.push(pathname);
    const { rerender } = render(
      <TestAdminPageCache
        pathname="/admin/scenarios"
        pages={{ '/admin/scenarios': <RouteActivityProbe pathname="/admin/scenarios" onActive={onActive} /> }}
      />,
    );

    rerender(
      <TestAdminPageCache
        pathname="/admin/image-center"
        pages={{ '/admin/image-center': <RouteActivityProbe pathname="/admin/image-center" onActive={onActive} /> }}
      />,
    );

    expect(activeRoutes).toEqual(['/admin/scenarios', '/admin/image-center']);

    rerender(
      <TestAdminPageCache
        pathname="/admin/scenarios"
        pages={{ '/admin/scenarios': <RouteActivityProbe pathname="/admin/scenarios" onActive={onActive} /> }}
      />,
    );

    expect(activeRoutes).toEqual(['/admin/scenarios', '/admin/image-center', '/admin/scenarios']);
  });
});
