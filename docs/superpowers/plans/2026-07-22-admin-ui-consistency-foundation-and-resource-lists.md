# Admin UI Consistency Foundation And Resource Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish stable protected-page loading and a reusable dense list language, then migrate single instances, range instances, image assets, and the existing scenario list without changing their APIs or lifecycle semantics.

**Architecture:** `AdminWorkspaceShell` becomes the single owner of protected-session readiness and displays a stable shell skeleton while the session hydrates or renews. App-local shared compositions provide a semantic table frame, table-body states, generalized toolbar, and status presentation; screens retain their data fetching, query parameters, polling, permissions, and mutation handlers while replacing only their presentation branches.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS v4, app-local shadcn/Radix primitives, Lucide, Vitest, Testing Library, Docker Compose.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/components/admin/shared/admin-data-table.tsx` | Dense table frame, column priorities, table busy state, and table-body empty/error state. |
| `apps/web/components/admin/shared/admin-data-table.test.tsx` | Accessibility, retained headers, state, column-priority, and retry tests for the table frame. |
| `apps/web/components/admin/shared/admin-list-toolbar.tsx` | Generic search/view/action toolbar for any list module. |
| `apps/web/components/admin/shared/admin-list-toolbar.test.tsx` | Search, view selection, and action-slot behavior tests. |
| `apps/web/components/admin/shared/status-badge.tsx` | Backward-compatible template publication badge plus reusable operational status badges. |
| `apps/web/components/admin/shared/status-badge.test.tsx` | Publication and lifecycle-status label/tone tests. |
| `apps/web/components/admin/admin-workspace-shell.tsx` | Protected session gate and stable workspace skeleton. |
| `apps/web/components/admin/admin-workspace-shell.test.tsx` | Session hydration/renewal skeleton and unauthorized redirect tests. |
| `apps/web/components/admin/templates-screen.tsx` | Normalize the already-migrated scenario list onto the generic data table and toolbar. |
| `apps/web/components/admin/templates-screen.test.tsx` | Preserve scenario behavior while asserting the normalized table state. |
| `apps/web/components/admin/single-instances-screen.tsx` | Migrate single-instance active/history list presentation and preserve URL view across refresh. |
| `apps/web/components/admin/single-instances-screen.states.test.tsx` | Focused empty/loading/revalidation/history-view tests that avoid the legacy large suite's memory pressure. |
| `apps/web/components/admin/range-instances-screen.tsx` | Migrate range-instance active/history presentation and add URL-backed history view. |
| `apps/web/components/admin/range-instances-screen.states.test.tsx` | Focused range-instance empty/loading/retry/history-view tests. |
| `apps/web/components/admin/image-center-screen.tsx` | Migrate image-center list presentation without changing tab lazy-loading or image workflows. |
| `apps/web/components/admin/image-center-screen.test.tsx` | Preserve existing workflows and add table-state coverage for an empty active tab. |
| `apps/web/app/globals.css` | Remove only the obsolete resource-list grid rules after a screen has switched to shared compositions; retain transition CSS used by untouched routes. |
| `apps/web/app/globals.css.test.ts` | Keep Tailwind custom-variant and responsive workspace contracts intact. |

## Docker Commands Used Throughout

All test commands run from the feature worktree:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test <test-files>
```

The only image build and runtime commands are:

```bash
docker compose -p for build web
docker compose -p for up -d --no-deps --force-recreate web
```

Never start, rebuild, or recreate API, worker, database, or Keycloak services.

### Task 1: Add The Shared Dense Table And Generic Toolbar

**Files:**
- Create: `apps/web/components/admin/shared/admin-data-table.tsx`
- Create: `apps/web/components/admin/shared/admin-data-table.test.tsx`
- Create: `apps/web/components/admin/shared/admin-list-toolbar.tsx`
- Create: `apps/web/components/admin/shared/admin-list-toolbar.test.tsx`
- Modify: `apps/web/components/admin/shared/status-badge.tsx`
- Modify: `apps/web/components/admin/shared/status-badge.test.tsx`

- [ ] **Step 1: Write failing dense-table and toolbar tests**

```tsx
it('keeps feature columns visible while the table body is empty', () => {
  render(
    <AdminDataTable
      columns={[
        { id: 'name', label: '实例名称', priority: 'primary' },
        { id: 'image', label: '镜像', priority: 'secondary' },
        { id: 'status', label: '状态', priority: 'primary' },
        { id: 'actions', label: '操作', priority: 'primary', align: 'right' },
      ]}
      label="实例列表"
    >
      <AdminDataTableState
        description="创建后，实例状态会显示在这里。"
        title="还没有实例"
        variant="empty"
      />
    </AdminDataTable>,
  );

  expect(screen.getByRole('columnheader', { name: '实例名称' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy();
  expect(screen.getByText('还没有实例')).toBeTruthy();
});

it('reports a retained snapshot as busy without replacing table rows', () => {
  render(
    <AdminDataTable columns={[{ id: 'name', label: '实例名称', priority: 'primary' }]} isRefreshing label="实例列表">
      <TableRow><TableCell>alpha</TableCell></TableRow>
    </AdminDataTable>,
  );

  expect(screen.getByRole('table', { name: '实例列表' }).getAttribute('aria-busy')).toBe('true');
  expect(screen.getByText('alpha')).toBeTruthy();
});
```

```tsx
it('forwards an arbitrary view and search value without naming a specific resource', () => {
  const onViewChange = vi.fn();

  render(
    <AdminListToolbar
      activeView="history"
      onSearchChange={vi.fn()}
      onViewChange={onViewChange}
      searchLabel="筛选实例名"
      searchPlaceholder="搜索实例名"
      views={[
        { value: 'active', label: '实例列表' },
        { value: 'history', label: '实例历史' },
      ]}
    />,
  );

  fireEvent.click(screen.getByRole('tab', { name: '实例列表' }));
  expect(onViewChange).toHaveBeenCalledWith('active');
});
```

- [ ] **Step 2: Run the new tests and confirm the missing imports fail**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx
```

Expected: FAIL because `AdminDataTable`, `AdminDataTableState`, and `AdminListToolbar` do not exist.

- [ ] **Step 3: Implement the table and toolbar with feature-owned columns**

```tsx
export type AdminDataColumn = {
  id: string;
  label: string;
  priority: 'primary' | 'secondary' | 'tertiary' | 'detail';
  align?: 'left' | 'right';
};

export function AdminDataTable({
  label,
  columns,
  children,
  isRefreshing = false,
}: {
  label: string;
  columns: AdminDataColumn[];
  children: ReactNode;
  isRefreshing?: boolean;
}) {
  return (
    <Table aria-busy={isRefreshing || undefined} aria-label={label}>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead
              className={cn(
                column.priority === 'detail' && 'hidden xl:table-cell',
                column.priority === 'tertiary' && 'hidden lg:table-cell',
                column.priority === 'secondary' && 'hidden md:table-cell',
                column.align === 'right' && 'text-right',
              )}
              key={column.id}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}
```

`AdminDataTableState` must render one semantic `TableRow` and one
`TableCell colSpan={columnCount}`. It must use an `Inbox` icon for empty,
`CircleAlert` for error, `AsyncContentState` for copy and retry, and preserve
the table's normal body minimum height. `AdminListToolbar` must take
`views?: Array<{ value: string; label: string }>` and an optional `action`
slot; it must omit `Tabs` when no views are supplied.

Extend `StatusBadge` with:

```tsx
type OperationalStatus =
  | 'running'
  | 'creating'
  | 'create_failed'
  | 'destroying'
  | 'destroy_failed'
  | 'destroyed'
  | 'enabled'
  | 'disabled';
```

Keep the current `published` and `private` API valid so `TemplatesScreen`
does not change behavior during this task.

- [ ] **Step 4: Run focused shared-component tests**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  components/admin/shared/status-badge.test.tsx \
  components/admin/shared/async-content-state.test.tsx \
  components/admin/shared/table-loading-state.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the shared language**

```bash
git add apps/web/components/admin/shared
git commit -m "feat(web): add shared admin data table language"
```

### Task 2: Stabilize Protected-Route Hydration And Renewal

**Files:**
- Create: `apps/web/components/admin/admin-workspace-loading-state.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`

- [ ] **Step 1: Add failing shell tests for the stable skeleton**

Add a controllable `useAdminSession` mock to the shell test and assert:

```tsx
it('keeps a workspace skeleton visible while the stored session hydrates', () => {
  sessionState.value = { isReady: false, token: null, refreshToken: null, profile: null, isAdmin: false };

  render(<AdminWorkspaceShell><div>route content</div></AdminWorkspaceShell>);

  expect(screen.getByLabelText('正在恢复管理会话')).toBeTruthy();
  expect(screen.queryByText('route content')).toBeNull();
  expect(replaceMock).not.toHaveBeenCalled();
});

it('keeps protected content hidden but the shell stable while renewing a valid session', async () => {
  sessionState.value = createExpiringSession();
  fetchMock.mockImplementation(() => new Promise(() => undefined));

  render(<AdminWorkspaceShell><div>route content</div></AdminWorkspaceShell>);

  expect(await screen.findByLabelText('正在续期管理会话')).toBeTruthy();
  expect(screen.queryByText('route content')).toBeNull();
});
```

- [ ] **Step 2: Run shell tests and verify the skeleton assertions fail**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx
```

Expected: FAIL because the shell currently returns `null` for hydration and
renewal.

- [ ] **Step 3: Implement `AdminWorkspaceLoadingState` and use it in the shell**

```tsx
export function AdminWorkspaceLoadingState({ label }: { label: string }) {
  return (
    <div aria-label={label} className="admin-workspace">
      <aside className="admin-sidebar"><Skeleton className="m-5 h-5 w-24" /></aside>
      <main className="admin-main-shell">
        <header className="admin-topbar"><Skeleton className="h-8 w-28" /></header>
        <section className="admin-main-content">
          <div className="space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        </section>
      </main>
    </div>
  );
}
```

Replace the three protected-route `return null` branches in
`AdminWorkspaceShell` with this component. Use `正在恢复管理会话` for
`!session.isReady`, `正在续期管理会话` for renewal, and keep the existing
login redirect effect for a resolved missing token. Do not change OIDC request
parameters, storage, or navigation targets.

- [ ] **Step 4: Run shell and CSS contract tests**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx \
  app/globals.css.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit hydration stability**

```bash
git add apps/web/components/admin/admin-workspace-loading-state.tsx \
  apps/web/components/admin/admin-workspace-shell.tsx \
  apps/web/components/admin/admin-workspace-shell.test.tsx
git commit -m "fix(web): stabilize protected workspace hydration"
```

### Task 3: Normalize The Existing Scenario List

**Files:**
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/shared/list-toolbar.tsx` only if it can delegate to `AdminListToolbar` without changing the required-child panel contract

- [ ] **Step 1: Add a failing scenario-list state test**

```tsx
it('keeps the scenario columns visible when the active view has no templates', async () => {
  fetchRangeTemplatesMock.mockResolvedValue([]);

  render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('columnheader', { name: '靶场' })).toBeTruthy();
  expect(screen.getByText('还没有靶场')).toBeTruthy();
  expect(screen.getByRole('button', { name: '新建拓扑' })).toBeTruthy();
});
```

- [ ] **Step 2: Run the targeted test and confirm it fails on the old state copy**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/templates-screen.test.tsx \
  --testNamePattern "keeps the scenario columns visible"
```

Expected: FAIL because the empty branch does not use the shared table state.

- [ ] **Step 3: Replace only scenario presentation branches**

Use `AdminListToolbar`, `AdminDataTable`, `AdminDataTableState`, and
`StatusBadge`. Keep the current `view` URL parameter, `mine/platform` lazy
loading, pagination, `loadAttempt` retry behavior, create/edit/launch/delete
handlers, and `ListToolbar` tab-panel accessibility contract. Declare the
feature columns as:

```tsx
const scenarioColumns: AdminDataColumn[] = [
  { id: 'name', label: '靶场', priority: 'primary' },
  { id: 'owner', label: '创建人', priority: 'secondary' },
  { id: 'description', label: '靶场描述', priority: 'detail' },
  { id: 'topology', label: '拓扑概览', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'actions', label: '操作', priority: 'primary', align: 'right' },
];
```

- [ ] **Step 4: Run scenario and shared-state regressions**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/templates-screen.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the scenario normalization**

```bash
git add apps/web/components/admin/templates-screen.tsx \
  apps/web/components/admin/templates-screen.test.tsx \
  apps/web/components/admin/shared/list-toolbar.tsx
git commit -m "refactor(web): normalize scenario list states"
```

### Task 4: Migrate Single-Instance Management

**Files:**
- Modify: `apps/web/components/admin/single-instances-screen.tsx`
- Create: `apps/web/components/admin/single-instances-screen.states.test.tsx`
- Modify: `apps/web/components/admin/single-instances-screen.test.tsx` only to retain existing behavior assertions if selectors change

- [ ] **Step 1: Write a small failing state suite**

Create the focused test with mocked admin APIs and `useAdminSession`:

```tsx
it('renders a stable instance table empty state after the active request resolves empty', async () => {
  fetchSingleInstancesMock.mockResolvedValue([]);
  fetchPlatformImagesMock.mockResolvedValue({ items: [] });
  fetchProvisionJobsMock.mockResolvedValue([]);

  render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={0} />);

  expect(await screen.findByRole('columnheader', { name: '实例名称' })).toBeTruthy();
  expect(screen.getByText('还没有实例')).toBeTruthy();
  expect(screen.getByText('请先前往镜像中心收录或启用至少一个平台镜像。')).toBeTruthy();
});

it('keeps the history table selected from the url before the first rows resolve', async () => {
  searchParamsState.value = 'view=history';
  fetchSingleInstancesMock.mockImplementation(() => new Promise(() => undefined));

  render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={0} />);

  expect(await screen.findByRole('tab', { name: '实例历史' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('columnheader', { name: '结束时间' })).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused state suite and confirm it fails**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/single-instances-screen.states.test.tsx
```

Expected: FAIL because the current screen uses bespoke grid headers and
`aria-pressed` buttons rather than the shared state frame.

- [ ] **Step 3: Migrate presentation without changing lifecycle behavior**

Replace bespoke toolbar, column-header grids, row grids, empty branches, and
ad-hoc action buttons with:

- `AdminPageHeader` titled `实例管理`
- `AdminListToolbar` with `active/history` views and the existing create button
- `AdminDataTable` with domain columns for batch name, image, quantity,
  status/result, time, creator, and actions
- `AdminDataTableState` for initial loading, empty, and failed initial request
- `StatusBadge` for all instance statuses
- `DropdownMenu` for low-frequency row actions and `ConfirmActionDialog` for
  destructive operations

Keep `readListMode(searchParams.get('view'))` as the initializer and make the
tab implementation expose semantic `role="tab"`/`aria-selected` state. Do not
change polling intervals, launch preflight, credentials display rules, VNC
handling, batch grouping, or API calls.

For revalidation, remove only the `setInstances([])`/`setBatchGroups([])`/
`setJobs([])` calls that run when a successful snapshot already exists. Keep
those resets for explicit session logout.

- [ ] **Step 4: Run focused and existing instance regressions**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/single-instances-screen.states.test.tsx \
  components/admin/single-instances-screen.test.tsx \
  components/admin/shared/admin-data-table.test.tsx
```

Expected: focused suite PASS. If the legacy suite exceeds the container heap,
record the exact failure separately and keep the focused state suite green.

- [ ] **Step 5: Commit single-instance migration**

```bash
git add apps/web/components/admin/single-instances-screen.tsx \
  apps/web/components/admin/single-instances-screen.states.test.tsx \
  apps/web/components/admin/single-instances-screen.test.tsx
git commit -m "refactor(web): unify single instance list states"
```

### Task 5: Migrate Range-Instance Management

**Files:**
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Create: `apps/web/components/admin/range-instances-screen.states.test.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx` only for retained existing behavior

- [ ] **Step 1: Write failing range state and URL-view tests**

```tsx
it('keeps range columns and a table-body empty state for no active instances', async () => {
  fetchRangeInstancesMock.mockResolvedValue([]);

  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('columnheader', { name: '实例名称' })).toBeTruthy();
  expect(screen.getByText('还没有编排实例')).toBeTruthy();
});

it('reads the history view from the URL before the first fetch settles', async () => {
  searchParamsState.value = 'view=history';
  fetchRangeInstancesMock.mockImplementation(() => new Promise(() => undefined));

  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('tab', { name: '实例历史' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('columnheader', { name: '回收时间' })).toBeTruthy();
});
```

- [ ] **Step 2: Run and verify the new suite fails**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/range-instances-screen.states.test.tsx
```

Expected: FAIL because `RangeInstancesScreen` does not currently read or write
the `view` query parameter and does not use semantic table columns.

- [ ] **Step 3: Implement URL-backed views and shared presentation**

Initialize range list mode from `useSearchParams()` with
`readListMode(searchParams.get('view'))`. Replace the old custom tab buttons
with `AdminListToolbar`, and update the URL with `window.history.replaceState`
when the user selects active or history. Use feature columns:

```tsx
const activeColumns = [
  { id: 'name', label: '实例名称', priority: 'primary' },
  { id: 'template', label: '所属靶场', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'createdAt', label: '创建时间', priority: 'secondary' },
  { id: 'actions', label: '操作', priority: 'primary', align: 'right' },
];
```

The history view adds `回收时间` and `运行时长` as secondary/detail columns.
Preserve `fetchProvisionJobs` lazy loading for history, detail navigation,
destroy/delete action conditions, and all unauthorized handling. Retain a
successful snapshot on revalidation instead of clearing it.

- [ ] **Step 4: Run range tests**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/range-instances-screen.states.test.tsx \
  components/admin/range-instances-screen.test.tsx
```

Expected: focused suite PASS. Document a separate memory-only failure from the
legacy suite if it still cannot complete under the container limit.

- [ ] **Step 5: Commit range-instance migration**

```bash
git add apps/web/components/admin/range-instances-screen.tsx \
  apps/web/components/admin/range-instances-screen.states.test.tsx \
  apps/web/components/admin/range-instances-screen.test.tsx
git commit -m "refactor(web): unify range instance list states"
```

### Task 6: Migrate Image Center Presentation

**Files:**
- Modify: `apps/web/components/admin/image-center-screen.tsx`
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`

- [ ] **Step 1: Add a failing active-tab empty-state test**

```tsx
it('keeps image columns visible with a table-body empty state for an empty platform tab', async () => {
  fetchPlatformImagesMock.mockResolvedValue({ items: [] });

  render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('columnheader', { name: '镜像名称' })).toBeTruthy();
  expect(screen.getByText('还没有平台镜像')).toBeTruthy();
  expect(screen.queryByText('0 条记录')).toBeNull();
});
```

- [ ] **Step 2: Run and confirm the state assertion fails**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/image-center-screen.test.tsx \
  --testNamePattern "keeps image columns visible"
```

Expected: FAIL because the current empty platform tab leaves only its old list
shell and count.

- [ ] **Step 3: Replace image-center presentation branches**

Use `AdminPageHeader`, `AdminListToolbar`, `AdminDataTable`,
`AdminDataTableState`, `StatusBadge`, `DropdownMenu`, and shared pagination.
The platform and personal tabs use columns for image name, image ID, creator,
status, and actions. Cloud-source tabs use their own source-specific columns;
do not force platform image columns onto cloud snapshots.

Preserve:

- initial platform load and lazy cloud-source tab loading
- import-job polling and temporary OSS cleanup behavior
- cloud-account context handling
- collect, upload, sync, publish, unpublish, rename, enable, disable, delete,
  and launch handlers
- existing access and owner/admin action rules

Do not clear a successful tab snapshot while a refresh request is in flight.

- [ ] **Step 4: Run image-center and shared regressions**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/image-center-screen.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/status-badge.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit image-center migration**

```bash
git add apps/web/components/admin/image-center-screen.tsx \
  apps/web/components/admin/image-center-screen.test.tsx
git commit -m "refactor(web): unify image center list states"
```

### Task 7: Resource-Wave Validation And Browser Audit

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

- [ ] **Step 1: Remove replaced resource-list CSS only after usage is gone**

Delete the obsolete `.range-workbench-*`, `.single-instance-workbench-*`, and
`.image-center-*` rules only when `rg` confirms no migrated component still
emits those class names. Keep rules referenced by untouched billing, users,
settings, detail, and editor surfaces.

Add a CSS contract assertion that the narrow workspace still uses `14px`
padding and that shared table priority classes hide detail, tertiary, and
secondary columns at `xl`, `lg`, and `md` breakpoints respectively.

- [ ] **Step 2: Run complete resource-wave regressions in bounded batches**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  app/globals.css.test.ts \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/templates-screen.test.tsx \
  components/admin/single-instances-screen.states.test.tsx \
  components/admin/range-instances-screen.states.test.tsx \
  components/admin/image-center-screen.test.tsx \
  components/admin/shared/admin-data-table.test.tsx \
  components/admin/shared/admin-list-toolbar.test.tsx \
  components/admin/shared/status-badge.test.tsx
```

Expected: PASS. Keep the two legacy high-memory files out of the combined
process; run them separately and report only a reproducible memory limit.

- [ ] **Step 3: Build and replace only web**

Run:

```bash
docker compose -p for build web
docker compose -p for up -d --no-deps --force-recreate web
```

Expected: Next production build succeeds and only `for-web-1` is recreated.

- [ ] **Step 4: Perform authenticated browser checks**

At desktop (`1440x900`) and narrow (`390x844`) viewports, verify:

1. `/admin/instances` empty, loading, and history-query layouts retain their
   table frame.
2. `/admin/ranges` active/history navigation preserves the view on reload.
3. `/admin/image-center` keeps platform columns visible for an empty active
   tab.
4. `/admin/scenarios` continues to render the migrated template list.
5. No overlapping text, collapsed action column, or unexpected redirect occurs.

Record screenshots without displaying cloud credentials or other sensitive
values.

- [ ] **Step 5: Commit resource-wave cleanup**

```bash
git add apps/web/app/globals.css apps/web/app/globals.css.test.ts
git commit -m "refactor(web): complete resource list consistency wave"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1-2 implement the shared table and stable session
  contract. Task 3 keeps the initial template migration aligned with the new
  language. Tasks 4-6 cover the resource/lifecycle list wave. Task 7 covers
  CSS retirement, Docker-only validation, browser audit, and responsive
  behavior. Users, billing, settings, and detail/editor surfaces are explicitly
  deferred to the next independent migration plan from the approved spec.
- **Placeholder scan:** No pending placeholders or unspecified commands remain.
- **Type consistency:** `AdminDataColumn`, `AdminDataTable`,
  `AdminDataTableState`, and `AdminListToolbar` are defined in Task 1 and used
  with the same names in later tasks. Both instance screens use `view=history`
  as the URL contract.
