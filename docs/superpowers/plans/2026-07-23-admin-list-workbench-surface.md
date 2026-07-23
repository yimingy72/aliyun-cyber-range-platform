# Admin List Workbench Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every list-oriented admin route use one compact workbench surface with a consistent page header, right-aligned action area, table frame, and pagination spacing.

**Architecture:** Keep feature modules responsible for their data, controls, and domain-specific fields. Strengthen `AdminPageHeader` and `AdminDataTable` as presentation-only shared primitives, then replace duplicate page-level card and table-frame classes with the shared workbench surface. Billing and single instances retain their specialized content structures but use the same header and parent-surface language.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS v4, app-local shadcn/Radix primitives, Lucide, Vitest, Testing Library, Docker Compose.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/components/admin/shared/admin-page-header.tsx` | Defines the one page-title, description, divider, and right-action composition used by list workbenches. |
| `apps/web/components/admin/shared/admin-page-header.test.tsx` | Verifies heading semantics, optional copy, and the stable action slot. |
| `apps/web/components/admin/shared/admin-data-table.tsx` | Owns the neutral bordered table frame, muted table-header band, existing column priorities, and in-table async states. |
| `apps/web/components/admin/shared/admin-data-table.test.tsx` | Verifies the shared frame and header treatment without changing column or busy-state contracts. |
| `apps/web/app/globals.css` | Adds the workbench-surface, table-frame, and narrow-screen spacing classes without changing global route behavior. |
| `apps/web/app/globals.css.test.ts` | Locks the workbench-surface and responsive spacing CSS contract. |
| `apps/web/components/admin/users-screen.tsx` | Removes duplicate table framing and uses the parent workbench surface. |
| `apps/web/components/admin/image-center-screen.tsx` | Uses the parent workbench surface and shared table frame for all image-source tabs. |
| `apps/web/components/admin/templates-screen.tsx` | Uses the parent workbench surface and shared table frame for both topology views. |
| `apps/web/components/admin/range-instances-screen.tsx` | Uses the parent workbench surface and shared table frame for active and history views. |
| `apps/web/components/admin/settings/settings-screen.tsx` | Uses the parent workbench surface while retaining the existing masked cloud-config form. |
| `apps/web/components/admin/single-instances-screen.tsx` | Replaces its bespoke heading and nested panel with the shared header and single workbench surface. |
| `apps/web/components/admin/billing-screen.tsx` | Uses the shared header and parent workbench surface while retaining its finance-detail and user-summary compositions. |
| `apps/web/components/admin/users-screen.test.tsx` | Protects the user-table header, toolbar, and action behavior after surface migration. |
| `apps/web/components/admin/billing-screen.test.tsx` | Protects the billing header, active-detail behavior, and detail workspace after surface migration. |
| `apps/web/components/admin/settings/settings-screen.test.tsx` | Protects the settings header action and masked config loading behavior after surface migration. |
| `apps/web/components/admin/single-instances-screen.states.test.tsx` | Protects the instance list header and first-load table state after the heading migration. |

## Docker Commands

Run commands from `/Users/yym/Documents/阿里云For综合靶场竞赛平台/.worktrees/admin-list-workbench-surface`.

After every frontend change, rebuild the web image before a container test:

```bash
docker compose -p for build web
```

Only after the final test batch, replace the already-running web service:

```bash
docker compose -p for up -d --no-deps --force-recreate web
```

Never rebuild, start, or recreate API, worker, database, Keycloak, or OpenTofu services.

### Task 1: Establish The Shared Surface Contract

**Files:**
- Modify: `apps/web/components/admin/shared/admin-page-header.tsx`
- Modify: `apps/web/components/admin/shared/admin-page-header.test.tsx`
- Modify: `apps/web/components/admin/shared/admin-data-table.tsx`
- Modify: `apps/web/components/admin/shared/admin-data-table.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

- [ ] **Step 1: Add failing shared-component and CSS contract assertions**

Add this page-header test:

```tsx
it('keeps the primary command in a stable right-aligned header action slot', () => {
  render(<AdminPageHeader action={<button type="button">创建实例</button>} title="实例管理" />);

  const header = screen.getByRole('heading', { level: 1 }).closest('header');
  const actionSlot = screen.getByRole('button', { name: '创建实例' }).parentElement;

  expect(header?.getAttribute('data-slot')).toBe('admin-page-header');
  expect(actionSlot?.getAttribute('data-slot')).toBe('admin-page-header-actions');
  expect(actionSlot?.className).toContain('sm:justify-end');
});
```

Add this table-frame test:

```tsx
it('wraps feature columns in the shared neutral table frame', () => {
  render(
    <AdminDataTable columns={instanceColumns} label="实例列表">
      {(columns) => (
        <TableRow>
          <AdminDataTableCell column={columns[0]}>alpha</AdminDataTableCell>
        </TableRow>
      )}
    </AdminDataTable>,
  );

  const table = screen.getByRole('table', { name: '实例列表' });
  const frame = table.closest('[data-slot="admin-data-table-frame"]');

  expect(frame?.className).toContain('rounded');
  expect(frame?.className).toContain('border');
  expect(frame?.className).toContain('bg-background');
  expect(table.querySelector('thead')?.className).toContain('bg-muted/60');
});
```

Add this CSS test:

```ts
it('defines one compact surface and responsive inset for admin list workbenches', () => {
  const surface = getRuleBlock(stylesheet, '.admin-workbench-surface');
  const narrowScreenRules = getAtRuleBlock(stylesheet, '@media (max-width: 640px)');

  expect(surface).toContain('border-radius: 6px');
  expect(surface).toContain('background: var(--card)');
  expect(surface).toContain('padding: 16px');
  expect(getRuleBlock(narrowScreenRules, '.admin-workbench-surface')).toContain('padding: 12px');
});
```

- [ ] **Step 2: Build and run the focused tests to verify they fail**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-page-header.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  app/globals.css.test.ts
```

Expected: FAIL because neither shared primitive exposes the new data slots or
table-frame wrapper, and the workbench-surface CSS contract does not exist.

- [ ] **Step 3: Implement the minimal shared presentation primitives**

Update `AdminPageHeader` to expose semantic slots while preserving its current
API:

```tsx
export function AdminPageHeader({ title, description, action }: AdminPageHeaderProps) {
  return (
    <header
      className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between"
      data-slot="admin-page-header"
    >
      <div className="min-w-0">
        <h1 className="font-heading text-xl font-semibold text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end" data-slot="admin-page-header-actions">
          {action}
        </div>
      ) : null}
    </header>
  );
}
```

Wrap the existing `Table` inside `AdminDataTable` without changing its column
or children contract:

```tsx
return (
  <div className="overflow-hidden rounded border border-border bg-background" data-slot="admin-data-table-frame">
    <Table aria-busy={isRefreshing || undefined} aria-label={label} className="min-w-full">
      <colgroup>
        {columns.map((column) => (
          <col className={columnPriorityColumnClassName(column.priority)} key={column.id} />
        ))}
      </colgroup>
      <TableHeader className="bg-muted/60">
        <TableRow className="hover:bg-transparent">
          {columns.map((column) => (
            <TableHead
              className={cn(
                'h-11 px-3',
                columnPriorityClassName(column.priority),
                column.align === 'right' && 'text-right',
              )}
              key={column.id}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children(columns)}</TableBody>
    </Table>
  </div>
);
```

Add these CSS rules near `.admin-workbench-panel`:

```css
.admin-workbench-surface {
  width: 100%;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  box-shadow: 0 2px 8px rgba(24, 44, 74, 0.06);
}

@media (max-width: 640px) {
  .admin-workbench-surface {
    padding: 12px;
  }
}
```

- [ ] **Step 4: Rebuild and verify the shared contract is green**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-page-header.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  components/admin/shared/async-content-state.test.tsx \
  components/admin/shared/table-loading-state.test.tsx \
  app/globals.css.test.ts
```

Expected: PASS with the existing table busy-state, responsive-column, and
in-table empty/error contracts intact.

- [ ] **Step 5: Commit the shared surface contract**

```bash
git add \
  apps/web/components/admin/shared/admin-page-header.tsx \
  apps/web/components/admin/shared/admin-page-header.test.tsx \
  apps/web/components/admin/shared/admin-data-table.tsx \
  apps/web/components/admin/shared/admin-data-table.test.tsx \
  apps/web/app/globals.css \
  apps/web/app/globals.css.test.ts
git commit -m "refactor(web): define admin workbench surface"
```

### Task 2: Migrate Standard Table Workbenches

**Files:**
- Create: `apps/web/components/admin/admin-list-workbench-surface.test.ts`
- Modify: `apps/web/components/admin/users-screen.tsx`
- Modify: `apps/web/components/admin/image-center-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Modify: `apps/web/components/admin/settings/settings-screen.tsx`

- [ ] **Step 1: Add a failing migration contract test**

Create `apps/web/components/admin/admin-list-workbench-surface.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const standardWorkbenchFiles = [
  'users-screen.tsx',
  'image-center-screen.tsx',
  'templates-screen.tsx',
  'range-instances-screen.tsx',
] as const;

describe('admin list workbench surface migration', () => {
  it('puts every standard list route on the shared parent surface', () => {
    for (const filename of standardWorkbenchFiles) {
      const source = readFileSync(resolve(process.cwd(), 'components/admin', filename), 'utf8');

      expect(source).toContain('admin-workbench-surface');
      expect(source).not.toContain('rounded-md border border-border bg-card p-4 shadow-sm');
    }
  });

  it('uses the shared surface for cloud settings without changing the form panel contract', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/admin/settings/settings-screen.tsx'), 'utf8');

    expect(source).toContain('admin-workbench-surface');
    expect(source).toContain('<CloudConfigPanel');
  });
});
```

- [ ] **Step 2: Build and run the migration contract to verify it fails**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-list-workbench-surface.test.ts
```

Expected: FAIL because standard screens still use route-local rounded card
classes and duplicate table-frame wrappers.

- [ ] **Step 3: Apply the shared surface and remove duplicate table framing**

Apply these exact parent-surface replacements:

```tsx
- <section className="admin-workbench-panel users-workbench-panel rounded-md border border-border bg-card p-4 shadow-sm">
+ <section className="admin-workbench-surface users-workbench-panel">

- <section className="rounded-md border border-border bg-card p-4 shadow-sm">
+ <section className="admin-workbench-surface">
```

Use the first replacement in `users-screen.tsx`. Use the second replacement
in `image-center-screen.tsx`, `templates-screen.tsx`,
`range-instances-screen.tsx`, and `settings/settings-screen.tsx`. Do not
change their `AdminPageHeader`, toolbar, action, tab, filter, table-state,
dialog, or pagination props.

Remove these duplicate table-frame classes while retaining their spacing:

```tsx
- <div className="mt-4 overflow-hidden rounded-md border border-border bg-background">
+ <div className="mt-4">

- <div className="overflow-hidden rounded-md border border-border">
+ <div>
```

Apply the first wrapper replacement in `users-screen.tsx`. Apply the second
in `image-center-screen.tsx`. Leave the `templates-screen.tsx` and
`range-instances-screen.tsx` table calls unwrapped. The table primitive owns
horizontal overflow containment and its visual border.

- [ ] **Step 4: Rebuild and verify all standard workbench migrations**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-list-workbench-surface.test.ts \
  components/admin/users-screen.test.tsx \
  components/admin/image-center-screen.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/range-instances-screen.states.test.tsx \
  components/admin/settings/settings-screen.test.tsx \
  components/admin/settings/cloud-config-panel.test.tsx
```

Expected: PASS. Existing table-body loading, empty, error, retained-snapshot,
image tab, topology view, URL-backed range history, and masked-settings
behavior remain unchanged.

- [ ] **Step 5: Commit the standard table-workbench migration**

```bash
git add \
  apps/web/components/admin/admin-list-workbench-surface.test.ts \
  apps/web/components/admin/users-screen.tsx \
  apps/web/components/admin/image-center-screen.tsx \
  apps/web/components/admin/templates-screen.tsx \
  apps/web/components/admin/range-instances-screen.tsx \
  apps/web/components/admin/settings/settings-screen.tsx
git commit -m "refactor(web): align admin list workbenches"
```

### Task 3: Align Specialized Instance And Billing Headers

**Files:**
- Modify: `apps/web/components/admin/single-instances-screen.tsx`
- Modify: `apps/web/components/admin/single-instances-screen.states.test.tsx`
- Modify: `apps/web/components/admin/billing-screen.tsx`
- Modify: `apps/web/components/admin/billing-screen.test.tsx`

- [ ] **Step 1: Add failing header and parent-surface tests**

Add this instance-page assertion:

```tsx
it('uses the shared instance-management header while the first table load is pending', () => {
  render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={0} />);

  const heading = screen.getByRole('heading', { level: 1, name: '实例管理' });

  expect(heading.closest('[data-slot="admin-page-header"]')).toBeTruthy();
  expect(heading.closest('.admin-workbench-surface')).toBeTruthy();
  expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();
});
```

Add this billing assertion:

```tsx
it('uses the shared billing header and retains the finance detail workspace', async () => {
  render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

  const heading = await screen.findByRole('heading', { level: 1, name: '账单费用' });

  expect(heading.closest('[data-slot="admin-page-header"]')).toBeTruthy();
  expect(heading.closest('.admin-workbench-surface')).toBeTruthy();
  expect(screen.getByRole('region', { name: '费用明细' })).toBeTruthy();
});
```

- [ ] **Step 2: Build and run the specialized page tests to verify they fail**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/single-instances-screen.states.test.tsx \
  components/admin/billing-screen.test.tsx
```

Expected: FAIL because single instances has a local level-two heading and
billing has a route-local header instead of `AdminPageHeader`.

- [ ] **Step 3: Migrate instance management and billing without changing their behavior**

For single instances, import `AdminPageHeader` and replace the local
`<article>` heading block with this header:

```tsx
<section className="admin-workbench-surface">
  <AdminPageHeader
    action={
      <Button disabled={!enabledPlatformImages.length} onClick={openCreateDialog} type="button">
        <Plus aria-hidden="true" data-icon="inline-start" />
        创建实例
      </Button>
    }
    description="创建并管理训练实例、批次与生命周期。"
    title="实例管理"
  />
```

Change the single-instance body wrapper from:

```tsx
- <article className="admin-workbench-panel range-workbench-shell overflow-hidden">
-   <header className="flex min-h-16 items-center border-b border-border px-5">
-     <h2 className="font-heading text-lg font-medium text-foreground">实例管理</h2>
-   </header>
+ <section className="admin-workbench-surface">
```

Keep the following `<div className="space-y-4 p-5">` content, but change its
class to `mt-4 space-y-4` and close the new `<section>` where the old
`</article>` was closed.

For billing, import `AdminPageHeader`, put the current export and sync controls
in its `action` slot, and make the current summary `<dl>` the first content
block below the header:

```tsx
<section className="admin-workbench-surface">
  <AdminPageHeader
    action={
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline">
              <Download aria-hidden="true" />
              导出账单
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={() => void handleExport('platform')}>导出平台账单</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleExport('users')}>导出用户汇总</DropdownMenuItem>
            <DropdownMenuItem disabled={!selectedUserId} onSelect={() => void handleExport('user')}>
              导出当前用户
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button disabled={isSyncing} onClick={() => void handleSync()} type="button">
          <RefreshCw aria-hidden="true" className={isSyncing ? 'animate-spin' : undefined} />
          {isSyncing ? '正在同步...' : '立即同步'}
        </Button>
      </>
    }
    description="查看平台开通与公共资源的费用明细。"
    title="账单费用"
  />
  <dl aria-label="账单概览" className="mt-4 flex flex-wrap items-stretch border-l border-border">
    <div className="grid min-w-36 gap-1 border-r border-border px-4">
      <dt className="text-xs font-medium text-muted-foreground">平台总应付</dt>
      <dd className="text-base font-semibold tabular-nums text-foreground">
        {summary ? formatMoney(summary.totalPretaxAmount) : isLoading ? <Skeleton className="h-5 w-20" /> : '¥ 0.00'}
      </dd>
    </div>
    <div className="grid min-w-36 gap-1 px-4">
      <dt className="text-xs font-medium text-muted-foreground">平台公共费用</dt>
      <dd className="text-base font-semibold tabular-nums text-foreground">
        {summary ? formatMoney(summary.platformPretaxAmount) : isLoading ? <Skeleton className="h-5 w-20" /> : '¥ 0.00'}
      </dd>
    </div>
  </dl>
</section>
```

Move the current error notices and `grid min-w-0 items-start` detail layout
inside this section immediately after the summary. Do not change billing fetch
effects, selected-user logic, selected-detail view logic, sync/export handlers,
date inputs, group expansion, or empty/error copy. Do not inspect or render the
cloud-settings route during visual validation.

- [ ] **Step 4: Rebuild and verify specialized pages**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/single-instances-screen.states.test.tsx \
  components/admin/billing-screen.test.tsx \
  components/admin/users-screen.test.tsx \
  components/admin/shared/admin-page-header.test.tsx \
  components/admin/shared/admin-data-table.test.tsx
```

Expected: PASS. The initial instance-table frame persists through loading and
the billing detail workspace stays idle when the current view is selected
again.

- [ ] **Step 5: Commit the specialized workbench alignment**

```bash
git add \
  apps/web/components/admin/single-instances-screen.tsx \
  apps/web/components/admin/single-instances-screen.states.test.tsx \
  apps/web/components/admin/billing-screen.tsx \
  apps/web/components/admin/billing-screen.test.tsx
git commit -m "refactor(web): align billing and instance workbenches"
```

### Task 4: Verify The Combined Workbench Language

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-admin-list-workbench-surface-design.md`

- [ ] **Step 1: Update the design status after implementation is complete**

Change:

```markdown
**Status:** Approved for implementation planning
```

to:

```markdown
**Status:** Implemented and verified
```

- [ ] **Step 2: Build and run the combined focused regression suite**

Run:

```bash
docker compose -p for build web
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  app/globals.css.test.ts \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/shared/admin-page-header.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  components/admin/shared/async-content-state.test.tsx \
  components/admin/shared/status-badge.test.tsx \
  components/admin/shared/table-loading-state.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/image-center-screen.test.tsx \
  components/admin/range-instances-screen.states.test.tsx \
  components/admin/single-instances-screen.states.test.tsx \
  components/admin/users-screen.test.tsx \
  components/admin/billing-screen.test.tsx \
  components/admin/settings/settings-screen.test.tsx \
  components/admin/settings/cloud-config-panel.test.tsx
```

Expected: PASS with current page interactions and shared list-state contracts
unchanged.

- [ ] **Step 3: Recreate only web and inspect the live platform**

Run:

```bash
docker compose -p for up -d --no-deps --force-recreate web
curl --fail --silent --show-error --location http://localhost:3000/admin/login -o /dev/null
```

Check user management, instance management, and billing at desktop and narrow
widths:

- each page has one bounded white workbench surface over the neutral canvas
- each title is a level-one shared header and the right action aligns with it
- search/view controls have one 16px gap below the header
- tables have one neutral bordered frame with a muted header band
- tables retain column headers for loading, empty, and error states
- billing preserves its specialized fee-detail and user-summary layout

Do not open, screenshot, or report cloud configuration values.

- [ ] **Step 4: Commit verification metadata**

```bash
git add docs/superpowers/specs/2026-07-23-admin-list-workbench-surface-design.md
git commit -m "docs: verify admin workbench surface"
```
