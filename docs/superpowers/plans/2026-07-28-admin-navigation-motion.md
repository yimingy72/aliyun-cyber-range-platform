# Admin Navigation Motion And Interaction Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin workspace acknowledge navigation and list-state changes with restrained, accessible motion while retaining stable data snapshots and the existing operational workflows.

**Architecture:** Keep routing and business state in their current feature screens. Add a route-keyed content transition at the admin shell, pending feedback to existing sidebar links, and shared data-table hooks for delayed refresh feedback plus table-body replacement. The four priority list screens only supply a monotonically increasing content revision after a successful data replacement; no API contract or lifecycle flow changes.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Radix UI, local shadcn-style components, Tailwind CSS v4, `tw-animate-css`, Vitest, Testing Library, Docker Compose.

---

## File Structure

- Create: `apps/web/components/admin/admin-content-transition.tsx`  
  Route-keyed client boundary that applies the shared content entrance class.
- Create: `apps/web/components/admin/admin-content-transition.test.tsx`  
  Verifies the semantic wrapper and that a pathname key restarts its entrance.
- Modify: `apps/web/app/globals.css`  
  Adds motion tokens, route/table feedback classes, delayed refresh-indicator keyframes, and reduced-motion overrides.
- Modify: `apps/web/app/globals.css.test.ts`  
  Locks the motion CSS contract and its reduced-motion fallback.
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`  
  Tracks and exposes a pending navigation item, renders the route-transition boundary, and keeps mobile drawer close behavior.
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`  
  Covers pending navigation, route completion, current-route clicks, and the shared content boundary.
- Modify: `apps/web/components/admin/shared/admin-data-table.tsx`  
  Adds a delayed visual refresh indicator and an optional `contentVersion` key for table-body replacement without clearing rows.
- Modify: `apps/web/components/admin/shared/admin-data-table.test.tsx`  
  Covers retained rows, immediate `aria-busy`, refresh marker, and content-body revision.
- Modify: `apps/web/components/admin/shared/admin-list-toolbar.tsx`  
  Marks the active tab panel as a small, local transition surface.
- Modify: `apps/web/components/admin/shared/admin-list-toolbar.test.tsx`  
  Confirms the active panel retains Radix keyboard association and receives the panel transition class.
- Modify: `apps/web/components/ui/tabs.tsx`  
  Changes the line-tab indicator from opacity-only to a short transform transition.
- Modify: `apps/web/components/ui/dialog.tsx`  
  Normalizes overlay/content durations to the shared short overlay cadence.
- Modify: `apps/web/components/ui/sheet.tsx`  
  Normalizes overlay/content durations to the shared short overlay cadence.
- Modify: `apps/web/components/admin/image-center-screen.tsx`  
  Increments a per-tab table revision after successful catalog replacement and supplies it to `AdminDataTable`.
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`  
  Covers retained rows and table-body replacement during a delayed refresh.
- Modify: `apps/web/components/admin/single-instances-screen.tsx`  
  Increments a per-view table revision after current instance rows and jobs are atomically replaced.
- Modify: `apps/web/components/admin/single-instances-screen.test.tsx`  
  Covers retained current rows and an animated body revision while a refresh is pending.
- Modify: `apps/web/components/admin/templates-screen.tsx`  
  Increments a per-view table revision after a template view fetch succeeds.
- Modify: `apps/web/components/admin/templates-screen.test.tsx`  
  Covers the loaded view’s table-body revision and no transient empty state.
- Modify: `apps/web/components/admin/range-instances-screen.tsx`  
  Increments a per-view table revision after range instances and jobs are replaced.
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`  
  Covers retained range rows, `aria-busy`, and the completed-refresh revision.

## Task 1: Define The Shared Motion Contract

**Files:**
- Create: `apps/web/components/admin/admin-content-transition.tsx`
- Create: `apps/web/components/admin/admin-content-transition.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

- [ ] **Step 1: Write the failing transition component and stylesheet tests**

Create `apps/web/components/admin/admin-content-transition.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminContentTransition } from './admin-content-transition';

describe('AdminContentTransition', () => {
  it('keys the content surface by pathname without adding another scroll container', () => {
    const { rerender } = render(
      <AdminContentTransition pathname="/admin/instances">
        <div>实例管理</div>
      </AdminContentTransition>,
    );

    const firstSurface = screen.getByTestId('admin-content-transition');
    expect(firstSurface.className).toContain('admin-content-transition');
    expect(firstSurface.textContent).toContain('实例管理');
    expect(firstSurface.getAttribute('data-route')).toBe('/admin/instances');

    rerender(
      <AdminContentTransition pathname="/admin/scenarios">
        <div>靶场编排</div>
      </AdminContentTransition>,
    );

    expect(screen.getByTestId('admin-content-transition').getAttribute('data-route')).toBe('/admin/scenarios');
  });
});
```

Add these assertions to `apps/web/app/globals.css.test.ts`:

```ts
it('defines restrained route and table feedback with a reduced-motion fallback', () => {
  const routeTransition = getRuleBlock(stylesheet, '.admin-content-transition');
  const tableRefresh = getRuleBlock(stylesheet, '.admin-data-table-refresh-indicator');
  const reducedMotion = getAtRuleBlock(stylesheet, '@media (prefers-reduced-motion: reduce)');

  expect(routeTransition).toContain('animation: admin-content-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both');
  expect(tableRefresh).toContain('animation: admin-table-refresh-reveal 160ms ease-out 150ms both');
  expect(stylesheet).toContain('@keyframes admin-content-enter');
  expect(stylesheet).toContain('@keyframes admin-table-content-enter');
  expect(reducedMotion).toContain('animation: none !important');
  expect(reducedMotion).toContain('transition-duration: 0.01ms !important');
});
```

- [ ] **Step 2: Run the focused tests in Docker and confirm they fail**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-content-transition.test.tsx \
  app/globals.css.test.ts
```

Expected: FAIL because `./admin-content-transition` and the CSS selectors/keyframes do not exist.

- [ ] **Step 3: Create the route-keyed transition boundary**

Create `apps/web/components/admin/admin-content-transition.tsx`:

```tsx
'use client';

import type { ReactNode } from 'react';

type AdminContentTransitionProps = {
  pathname: string;
  children: ReactNode;
};

export function AdminContentTransition({ pathname, children }: AdminContentTransitionProps) {
  return (
    <div className="admin-content-transition" data-route={pathname} data-testid="admin-content-transition" key={pathname}>
      {children}
    </div>
  );
}
```

The key belongs on the transition surface rather than the outer workspace or
scroll owner. Navigation remounts only the content surface and cannot reset the
sidebar, session state, topbar, or scroll container.

- [ ] **Step 4: Add the motion tokens and reduced-motion rule**

Append the following near the existing `.admin-main-content` rules in
`apps/web/app/globals.css`:

```css
@keyframes admin-content-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes admin-table-content-enter {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes admin-table-refresh-reveal {
  from {
    opacity: 0;
    transform: scaleX(0.6);
  }

  to {
    opacity: 1;
    transform: scaleX(1);
  }
}

.admin-content-transition {
  min-width: 0;
  min-height: 0;
  animation: admin-content-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.admin-data-table-body-enter {
  animation: admin-table-content-enter 160ms ease-out both;
}

.admin-data-table-refresh-indicator {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  opacity: 0;
  transform-origin: left;
  background: var(--primary);
  pointer-events: none;
}

[data-slot='admin-data-table-frame'][data-refreshing='true'] .admin-data-table-refresh-indicator {
  animation: admin-table-refresh-reveal 160ms ease-out 150ms both;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Do not animate width, table height, grid dimensions, or any property that
creates a competing scroll or layout calculation.

- [ ] **Step 5: Run the focused tests and the web build in Docker**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-content-transition.test.tsx \
  app/globals.css.test.ts
docker compose -p for build web
```

Expected: PASS; the image build completes the Next.js type check and production
build.

- [ ] **Step 6: Commit the shared motion contract**

```bash
git add apps/web/components/admin/admin-content-transition.tsx \
  apps/web/components/admin/admin-content-transition.test.tsx \
  apps/web/app/globals.css \
  apps/web/app/globals.css.test.ts
git commit -m "feat(web): add restrained admin motion tokens"
```

## Task 2: Add Immediate Navigation Feedback And Route Entrance

**Files:**
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx:34-125,127-326`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx:153-430`

- [ ] **Step 1: Extend the shell tests before changing navigation**

Add a primary-button click test that confirms the source link is busy before
the pathname changes, then clears after a rerender:

```tsx
it('marks a different destination as pending until the pathname reaches it', async () => {
  writeAdminSession(createSession());
  const { rerender } = render(
    <AdminWorkspaceShell>
      <div>workspace content</div>
    </AdminWorkspaceShell>,
  );

  await screen.findByText('workspace content');
  fireEvent.click(screen.getByRole('link', { name: /镜像中心/i }));

  expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-busy')).toBe('true');
  expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('aria-current')).toBe('page');

  pathnameState.value = '/admin/image-center';
  rerender(
    <AdminWorkspaceShell>
      <div>image workspace</div>
    </AdminWorkspaceShell>,
  );

  expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-busy')).toBeNull();
  expect(screen.getByRole('link', { name: /镜像中心/i }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByTestId('admin-content-transition').getAttribute('data-route')).toBe('/admin/image-center');
});

it('does not mark the current destination as pending', async () => {
  writeAdminSession(createSession());
  render(
    <AdminWorkspaceShell>
      <div>workspace content</div>
    </AdminWorkspaceShell>,
  );

  await screen.findByText('workspace content');
  fireEvent.click(screen.getByRole('link', { name: /靶场编排/i }));

  expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('aria-busy')).toBeNull();
});
```

- [ ] **Step 2: Run the shell test and confirm it fails**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx
```

Expected: FAIL because navigation links do not yet expose `aria-busy` and the
shell does not render `AdminContentTransition`.

- [ ] **Step 3: Thread the pending href through the two navigation instances**

Make these type and rendering changes in
`apps/web/components/admin/admin-workspace-shell.tsx`:

```tsx
type AdminNavigationProps = {
  items: readonly AdminNavigationItem[];
  onNavigate: (href: string) => void;
  pathname: string;
  pendingHref: string | null;
  className?: string;
};

function AdminNavigation({ items, onNavigate, pathname, pendingHref, className }: AdminNavigationProps) {
  return (
    <nav aria-label="后台导航" className={cn('grid content-start gap-1.5', className)}>
      {items.map((item) => {
        const isActive = isNavigationItemActive(pathname, item.href);
        const isPending = pendingHref === item.href;

        return (
          <Link
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
            key={item.href}
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
```

In `AdminWorkspaceShell`, import `AdminContentTransition`, add
`const [pendingHref, setPendingHref] = useState<string | null>(null);`, then
clear it when the active pathname reaches the destination:

```tsx
useEffect(() => {
  setPendingHref((current) => (current && isNavigationItemActive(pathname, current) ? null : current));
}, [pathname]);

function handleNavigate(href: string) {
  setIsNavigationOpen(false);

  if (!isNavigationItemActive(pathname, href)) {
    setPendingHref(href);
  }
}
```

Pass `handleNavigate` and `pendingHref` to both desktop and sheet
`AdminNavigation` calls. Replace the final content section with:

```tsx
<div className="admin-main-content-shell">
  <section className="admin-main-content">
    <AdminContentTransition pathname={pathname}>{children}</AdminContentTransition>
  </section>
</div>
```

Do not call `router.push` from the click handler. `Link` continues to own
Next.js navigation, modified clicks retain browser behavior, and the visual
pending state is cleared by the real pathname.

- [ ] **Step 4: Run the shell, transition, and CSS tests in Docker**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/admin-content-transition.test.tsx \
  app/globals.css.test.ts
```

Expected: PASS; current session renewal and role-filtered navigation tests stay
green.

- [ ] **Step 5: Commit shell feedback**

```bash
git add apps/web/components/admin/admin-workspace-shell.tsx \
  apps/web/components/admin/admin-workspace-shell.test.tsx
git commit -m "feat(web): acknowledge admin navigation"
```

## Task 3: Make Shared Tables And Tabs Communicate Local Progress

**Files:**
- Modify: `apps/web/components/admin/shared/admin-data-table.tsx`
- Modify: `apps/web/components/admin/shared/admin-data-table.test.tsx`
- Modify: `apps/web/components/admin/shared/admin-list-toolbar.tsx`
- Modify: `apps/web/components/admin/shared/admin-list-toolbar.test.tsx`
- Modify: `apps/web/components/ui/tabs.tsx`
- Modify: `apps/web/components/ui/dialog.tsx`
- Modify: `apps/web/components/ui/sheet.tsx`

- [ ] **Step 1: Write failing tests for table progress and the tab panel class**

Add this to `apps/web/components/admin/shared/admin-data-table.test.tsx`:

```tsx
it('announces refresh immediately, delays only the visual indicator, and keys a completed body replacement', () => {
  const columns = [{ id: 'name', label: '实例名称', priority: 'primary' as const }];
  const { rerender } = render(
    <AdminDataTable columns={columns} contentVersion={1} isRefreshing label="实例列表">
      {(tableColumns) => (
        <TableRow>
          <AdminDataTableCell column={tableColumns[0]}>alpha</AdminDataTableCell>
        </TableRow>
      )}
    </AdminDataTable>,
  );

  const table = screen.getByRole('table', { name: '实例列表' });
  const frame = table.closest('[data-slot="admin-data-table-frame"]');
  expect(table.getAttribute('aria-busy')).toBe('true');
  expect(frame?.getAttribute('data-refreshing')).toBe('true');
  expect(frame?.querySelector('.admin-data-table-refresh-indicator')).toBeTruthy();
  expect(table.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');

  rerender(
    <AdminDataTable columns={columns} contentVersion={2} label="实例列表">
      {(tableColumns) => (
        <TableRow>
          <AdminDataTableCell column={tableColumns[0]}>bravo</AdminDataTableCell>
        </TableRow>
      )}
    </AdminDataTable>,
  );

  expect(screen.getByText('bravo')).toBeTruthy();
  expect(screen.getByRole('table', { name: '实例列表' }).getAttribute('aria-busy')).toBeNull();
});
```

Add this assertion to the existing keyboard-view test in
`apps/web/components/admin/shared/admin-list-toolbar.test.tsx`:

```tsx
expect(panel.className).toContain('admin-list-toolbar-panel');
```

- [ ] **Step 2: Run the shared component tests and confirm they fail**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx
```

Expected: FAIL because `contentVersion`, `data-refreshing`, the progress marker,
and `admin-list-toolbar-panel` do not exist.

- [ ] **Step 3: Extend the table without clearing its body**

Change `AdminDataTableProps` and its render path to:

```tsx
interface AdminDataTableProps {
  label: string;
  columns: readonly AdminDataColumn[];
  children: (columns: readonly AdminDataColumn[]) => ReactNode;
  contentVersion?: number;
  isRefreshing?: boolean;
}

export function AdminDataTable({
  label,
  columns,
  children,
  contentVersion,
  isRefreshing = false,
}: AdminDataTableProps) {
  return (
    <TooltipProvider>
      <div
        className="relative overflow-hidden rounded border border-border bg-background"
        data-refreshing={isRefreshing || undefined}
        data-slot="admin-data-table-frame"
      >
        <span aria-hidden="true" className="admin-data-table-refresh-indicator" />
        <Table aria-busy={isRefreshing || undefined} aria-label={label} className="min-w-full table-fixed">
          {/* Retain the existing colgroup and TableHeader between this Table opening tag and TableBody. */}
          <TableBody className={contentVersion === undefined ? undefined : 'admin-data-table-body-enter'} key={contentVersion}>
            {children(columns)}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}
```

The DOM progress marker appears immediately but remains visually transparent
until the CSS animation’s 150ms delay passes. `aria-busy` changes immediately,
so assistive technology does not wait for a cosmetic delay. A feature screen
changes `contentVersion` only after a successful response; it never removes
rows to create an animation.

- [ ] **Step 4: Add the local tab-panel class and smooth the existing primitive animations**

In `apps/web/components/admin/shared/admin-list-toolbar.tsx`, replace:

```tsx
<TabsContent value={props.activeView}>{props.children}</TabsContent>
```

with:

```tsx
<TabsContent className="admin-list-toolbar-panel" value={props.activeView}>
  {props.children}
</TabsContent>
```

In `apps/web/components/ui/tabs.tsx`, replace the line indicator’s
`after:transition-opacity` with:

```tsx
after:origin-left after:scale-x-0 after:transition-transform
group-data-[variant=line]/tabs-list:data-active:after:scale-x-100
```

Keep `after:opacity-0` and the active opacity rule only if the compiled class
set requires it for backward compatibility; the active state must use transform
as the visible movement. In `dialog.tsx` and `sheet.tsx`, change the overlay
`duration-100` utilities to `duration-200`. Keep Radix titles, focus trapping,
escape dismissal, and the current `data-open`/`data-closed` selectors intact.

Add this CSS block beside the Task 1 motion rules:

```css
.admin-list-toolbar-panel {
  animation: admin-table-content-enter 160ms ease-out both;
}
```

- [ ] **Step 5: Run shared component tests in Docker**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  app/globals.css.test.ts
```

Expected: PASS; the table remains valid HTML, retains existing rows while busy,
and Radix tab keyboard association remains unchanged.

- [ ] **Step 6: Commit shared progress feedback**

```bash
git add apps/web/components/admin/shared/admin-data-table.tsx \
  apps/web/components/admin/shared/admin-data-table.test.tsx \
  apps/web/components/admin/shared/admin-list-toolbar.tsx \
  apps/web/components/admin/shared/admin-list-toolbar.test.tsx \
  apps/web/components/ui/tabs.tsx \
  apps/web/components/ui/dialog.tsx \
  apps/web/components/ui/sheet.tsx \
  apps/web/app/globals.css
git commit -m "feat(web): animate shared admin list feedback"
```

## Task 4: Supply Completed-Refresh Revisions From Priority Lists

**Files:**
- Modify: `apps/web/components/admin/image-center-screen.tsx:521-1020,1653-1888`
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`
- Modify: `apps/web/components/admin/single-instances-screen.tsx:503-600,1456-1510`
- Modify: `apps/web/components/admin/single-instances-screen.test.tsx`
- Modify: `apps/web/components/admin/templates-screen.tsx:182-290,700-790`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx:180-290,474-620`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`

- [ ] **Step 1: Add failing screen assertions for retained snapshots and revision output**

In each screen test, start a refresh with an unresolved mocked fetch, assert the
existing row remains visible and the feature table has `aria-busy="true"`, then
resolve the fetch and assert the data-table `tbody` has the shared enter class.
Use the current domain fixtures and labels:

```tsx
const imageTable = await screen.findByRole('table', { name: '我的镜像' });
expect(await within(imageTable).findByText('My Ubuntu 22.04')).toBeTruthy();
expect(imageTable.getAttribute('aria-busy')).toBe('true');

const singleInstanceTable = screen.getByRole('table', { name: '实例列表' });
expect(within(singleInstanceTable).getByText('web-lab-01')).toBeTruthy();
expect(singleInstanceTable.getAttribute('aria-busy')).toBe('true');

const templateTable = screen.getByRole('table', { name: '靶场列表' });
expect(within(templateTable).getByText('办公网横向移动靶场')).toBeTruthy();

const rangeTable = screen.getByRole('table', { name: '编排实例列表' });
expect(within(rangeTable).getByText('蓝队靶场 01')).toBeTruthy();
expect(rangeTable.getAttribute('aria-busy')).toBe('true');
```

Add one test to each of these existing suites:

- `ImageCenterScreen`: delayed refresh of the active `我的镜像` tab retains an
  image row and revises only that tab’s table body.
- `SingleInstancesScreen`: polling refresh retains the active instance row and
  revises the current `listMode` table body after its instances and jobs settle.
- `TemplatesScreen`: an unloaded view still uses skeleton rows; a successful
  `mine` or `platform` response revises that view without showing the empty
  state first.
- `RangeInstancesScreen`: retry/refresh retains a loaded range instance,
  reports busy, then revises the selected active/history table body.

After resolving each test-specific deferred promise, assert the matching table:

```tsx
expect(imageTable.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');
expect(imageTable.getAttribute('aria-busy')).toBeNull();

expect(singleInstanceTable.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');
expect(singleInstanceTable.getAttribute('aria-busy')).toBeNull();

expect(templateTable.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');

expect(rangeTable.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');
expect(rangeTable.getAttribute('aria-busy')).toBeNull();
```

- [ ] **Step 2: Run the four screen tests in Docker and confirm the new assertions fail**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/image-center-screen.test.tsx \
  components/admin/single-instances-screen.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/range-instances-screen.test.tsx
```

Expected: FAIL because none of the four `AdminDataTable` calls supply a
completed-refresh `contentVersion`.

- [ ] **Step 3: Add per-view revision maps and increment only after successful replacement**

Use the same local state shape in list screens that already cache independent
views:

```tsx
const [tableContentVersions, setTableContentVersions] = useState<Record<ListMode, number>>({
  active: 0,
  history: 0,
});

function markTableContentUpdated(view: ListMode) {
  setTableContentVersions((current) => ({
    ...current,
    [view]: current[view] + 1,
  }));
}
```

For `RangeInstancesScreen`, call
`markTableContentUpdated(listMode)` immediately after setting both
`instancesByView[listMode]`, `jobsByView[listMode]`, and
`loadedViews[listMode]` in the successful `reloadRangeInstanceRows` effect.
Pass `contentVersion={tableContentVersions[listMode]}` to `AdminDataTable`.

For `SingleInstancesScreen`, use `Record<ListMode, number>`, call
`markTableContentUpdated(nextListMode)` immediately after
`setBatchGroups`, `setInstances`, `setJobs`, and `setLoadedListMode` succeed
inside `refreshSingleInstanceRows`, then pass
`contentVersion={tableContentVersions[listMode]}` to the existing table.

For `TemplatesScreen`, use `Record<RangeTemplateView, number>`, increment
inside the successful `fetchRangeTemplates(...).then(...)` branch after the
matching view’s templates are stored and marked loaded, and pass
`contentVersion={tableContentVersions[activeView]}`.

For `ImageCenterScreen`, use `Record<ActiveTab, number>` for `platform`,
`mine`, `custom`, and `public`. Increment only at the four successful catalog
replacement points:

```tsx
setPlatformAssets(payload.items);
markTableContentUpdated('platform');

setMyAssets(myAssetsPayload.items);
markTableContentUpdated('mine');

setCustomScope(scope);
markTableContentUpdated('custom');

setPublicScope(scope);
markTableContentUpdated('public');
```

Also increment after `syncPublicImages` and `syncCustomImages` replace their
respective scope, because those are user-triggered completed list snapshots.
Do not increment for search text, pagination, dialog state, loading, failure,
or a mutation that has not produced a new list snapshot. Pass
`contentVersion={tableContentVersions[activeTab]}` to the image center table.

Reset each map to zero with the screen’s existing logout/session reset path.
Feature-specific mutations that already update rows optimistically remain
unchanged; their current state update is not treated as a fetched-list
replacement.

- [ ] **Step 4: Run all priority-list tests in Docker**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/image-center-screen.test.tsx \
  components/admin/single-instances-screen.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/range-instances-screen.test.tsx \
  components/admin/shared/admin-data-table.test.tsx
```

Expected: PASS; no screen clears a successful snapshot during refresh and all
existing authorization, row-action, retry, URL-view, and pagination tests
remain green.

- [ ] **Step 5: Commit the screen integrations**

```bash
git add apps/web/components/admin/image-center-screen.tsx \
  apps/web/components/admin/image-center-screen.test.tsx \
  apps/web/components/admin/single-instances-screen.tsx \
  apps/web/components/admin/single-instances-screen.test.tsx \
  apps/web/components/admin/templates-screen.tsx \
  apps/web/components/admin/templates-screen.test.tsx \
  apps/web/components/admin/range-instances-screen.tsx \
  apps/web/components/admin/range-instances-screen.test.tsx
git commit -m "feat(web): retain and transition admin list snapshots"
```

## Task 5: Verify The Delivered Interaction In Containers

**Files:**
- No source changes expected.

- [ ] **Step 1: Build the changed Web image**

```bash
COMPOSE_BAKE=false docker compose -p for build web
```

Expected: `for-web` builds successfully and Next.js completes its production
type check.

- [ ] **Step 2: Run the complete affected Web test set in a container**

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  app/globals.css.test.ts \
  components/admin/admin-content-transition.test.tsx \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  components/admin/image-center-screen.test.tsx \
  components/admin/single-instances-screen.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/range-instances-screen.test.tsx
```

Expected: PASS. Do not substitute a local development server for this
containerized test run.

- [ ] **Step 3: Recreate only the Web service**

```bash
docker compose -p for up -d --no-deps --force-recreate web
docker compose -p for ps web
```

Expected: the Web service is running; API, worker, database, and Keycloak are
not recreated.

- [ ] **Step 4: Perform browser checks against the containerized platform**

At desktop and narrow viewport sizes, authenticate normally and verify:

1. Click each primary navigation item: image center, instances, scenarios, and
   range instances. The source item acknowledges the click immediately; the
   content surface enters once; no full workspace blanking or horizontal page
   slide occurs.
2. In every priority list, switch its view tabs, search, paginate, and trigger
   a refresh where the route permits it. The table frame, column headers, and
   old snapshot remain stable while the request is busy.
3. Confirm a fast refresh does not visibly flash the progress line; use a
   throttled network request over 150ms to confirm that the local table marker
   appears without removing rows.
4. Open and close a menu, dialog, and mobile navigation sheet. Keyboard focus,
   Escape, and dismissal work exactly as before.
5. Emulate `prefers-reduced-motion: reduce` and repeat navigation, a tab
   change, and a delayed list refresh. State changes remain immediate and
   understandable without transform or keyframe motion.
6. Inspect browser console output. There must be no hydration warning,
   navigation error, unhandled promise rejection, or layout shift caused by a
   transition wrapper.

- [ ] **Step 5: Commit the final verification record only if it introduces a necessary tracked artifact**

No documentation change is required for a clean verification. If a regression
requires a code correction, add a focused test first, rerun Steps 1-4, and
commit the correction with the modified source and test files.
