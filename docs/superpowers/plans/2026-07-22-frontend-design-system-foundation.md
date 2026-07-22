# Frontend Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tailwind CSS v4 and shadcn/Radix design system to `apps/web`, then migrate the admin shell and range-template list without changing any API, session, permission, pagination, or template lifecycle behavior.

**Architecture:** Keep shadcn primitives as project-owned files in `apps/web/components/ui`, layer platform compositions in `apps/web/components/admin/shared`, and leave data fetching in existing screen components. Introduce Tailwind incrementally beside the existing global stylesheet so pages outside the first migration remain stable.

**Tech Stack:** Next.js 15, React 19.1.1, TypeScript, Tailwind CSS v4, shadcn/ui with Radix, Lucide React, Vitest, Testing Library, Docker Compose, Playwright CLI.

---

## Locked File Structure

| Path | Responsibility |
|---|---|
| `apps/web/package.json` | Pin the web React runtime and declare Tailwind, PostCSS, and Lucide dependencies. |
| `pnpm-lock.yaml` | Resolve the exact workspace dependency graph. |
| `apps/web/postcss.config.mjs` | Enable Tailwind v4 through the PostCSS plugin. |
| `apps/web/components.json` | Make the shadcn CLI generate source into the web application. |
| `apps/web/tsconfig.json` | Define the `@/*` alias used by generated and platform components. |
| `apps/web/lib/utils.ts` | Export the shared `cn()` class merger. |
| `apps/web/components/ui/*.tsx` | Project-owned shadcn/Radix primitives. |
| `apps/web/components/admin/shared/*.tsx` | Platform-level header, toolbar, status, async-state, and confirmation compositions. |
| `apps/web/components/admin/admin-workspace-shell.tsx` | Preserve session logic while rendering the responsive shell with the new primitives. |
| `apps/web/components/admin/templates-screen.tsx` | Preserve current template behavior while replacing its list presentation. |
| `apps/web/app/globals.css` | Add Tailwind imports, design tokens, and only transition rules required by the shell and template workbench. |
| `apps/web/**/**.test.tsx` | Regression, interaction, and accessibility tests. |

## Task 1: Restore A Working React Testing Baseline

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `apps/web/components/admin/templates-screen.test.tsx`

- [ ] **Step 1: Run the existing rendered component test in the web container**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/templates-screen.test.tsx \
    --testNamePattern "renders the scenario workbench"
  ```

  Expected: FAIL before a test assertion, with `React.act is not a function`. The current lockfile resolves React and React DOM to `19.2.7`, while the application declares compatibility with `19.1.1`.

- [ ] **Step 2: Pin the web runtime to the tested React minor version**

  In `apps/web/package.json`, replace the two runtime declarations with:

  ```json
  "react": "19.1.1",
  "react-dom": "19.1.1"
  ```

  Keep the existing Next.js version and every other dependency unchanged.

- [ ] **Step 3: Regenerate the workspace lockfile**

  Run from the repository root:

  ```bash
  pnpm install --lockfile-only
  ```

  Expected: `pnpm-lock.yaml` resolves the web importer and its React dependency graph to `19.1.1`.

- [ ] **Step 4: Re-run the same existing test in a freshly built web container**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/templates-screen.test.tsx \
    --testNamePattern "renders the scenario workbench"
  ```

  Expected: PASS. The test must reach its assertions rather than fail in Testing Library initialization.

- [ ] **Step 5: Commit the test-runtime correction**

  Run:

  ```bash
  git add apps/web/package.json pnpm-lock.yaml
  git commit -m "fix(web): restore React test compatibility"
  ```

## Task 2: Install The Tailwind And shadcn Foundation

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/components.json`
- Modify: `apps/web/tsconfig.json`
- Create: `apps/web/lib/utils.ts`
- Create: `apps/web/components/ui/button.tsx`
- Create: `apps/web/components/ui/input.tsx`
- Create: `apps/web/components/ui/label.tsx`
- Create: `apps/web/components/ui/select.tsx`
- Create: `apps/web/components/ui/tabs.tsx`
- Create: `apps/web/components/ui/dialog.tsx`
- Create: `apps/web/components/ui/dropdown-menu.tsx`
- Create: `apps/web/components/ui/tooltip.tsx`
- Create: `apps/web/components/ui/table.tsx`
- Create: `apps/web/components/ui/badge.tsx`
- Create: `apps/web/components/ui/skeleton.tsx`
- Create: `apps/web/components/ui/pagination.tsx`
- Create: `apps/web/components/ui/sheet.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

- [ ] **Step 1: Write the failing stylesheet contract test**

  Add this test to `apps/web/app/globals.css.test.ts`:

  ```ts
  it('declares the shadcn-compatible design tokens without changing admin scroll ownership', () => {
    expect(stylesheet).toContain('@import "tailwindcss";');
    expect(stylesheet).toContain('--background:');
    expect(stylesheet).toContain('--foreground:');
    expect(stylesheet).toContain('--primary:');
    expect(stylesheet).toContain('--radius:');
  });
  ```

  Keep the existing scroll ownership tests unchanged.

- [ ] **Step 2: Run the stylesheet test and verify the new contract fails**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test app/globals.css.test.ts
  ```

  Expected: FAIL because the Tailwind import and shadcn token names do not exist yet.

- [ ] **Step 3: Install build-time and icon dependencies**

  Run from the repository root:

  ```bash
  pnpm --filter @aliyun-cyber-range/web add lucide-react
  pnpm --filter @aliyun-cyber-range/web add -D tailwindcss @tailwindcss/postcss
  ```

  The production dependency is `lucide-react`; Tailwind and the PostCSS adapter remain development dependencies.

- [ ] **Step 4: Configure PostCSS, aliases, and shadcn**

  Create `apps/web/postcss.config.mjs`:

  ```js
  export default {
    plugins: {
      '@tailwindcss/postcss': {},
    },
  };
  ```

  Add this alias to `apps/web/tsconfig.json` inside `compilerOptions`:

  ```json
  "baseUrl": ".",
  "paths": {
    "@/*": ["./*"]
  }
  ```

  Initialize shadcn from `apps/web`:

  ```bash
  pnpm dlx shadcn@latest init \
    --template next \
    --base radix \
    --preset rhea \
    --no-monorepo \
    --css-variables \
    --yes
  ```

  The generated `components.json` must keep these aliases:

  ```json
  {
    "aliases": {
      "components": "@/components",
      "ui": "@/components/ui",
      "utils": "@/lib/utils"
    }
  }
  ```

- [ ] **Step 5: Generate the first primitive set**

  Run from `apps/web`:

  ```bash
  pnpm dlx shadcn@latest add --yes \
    button input label select tabs dialog dropdown-menu tooltip \
    table badge skeleton pagination sheet
  ```

  Do not hand-edit generated primitive source during this task.

- [ ] **Step 6: Define the transition tokens**

  At the start of `apps/web/app/globals.css`, add:

  ```css
  @import "tailwindcss";

  :root {
    --background: #eff4fb;
    --foreground: #1d2b44;
    --card: #ffffff;
    --card-foreground: #1d2b44;
    --popover: #ffffff;
    --popover-foreground: #1d2b44;
    --primary: #1f5fbf;
    --primary-foreground: #ffffff;
    --secondary: #edf3fb;
    --secondary-foreground: #21314c;
    --muted: #f5f7fb;
    --muted-foreground: #617089;
    --accent: #e9f1ff;
    --accent-foreground: #184b97;
    --destructive: #bf3f45;
    --border: #d7dfe9;
    --input: #d7dfe9;
    --ring: #1f5fbf;
    --radius: 0.5rem;
  }
  ```

  Preserve all existing custom properties and selectors below this block. Do not remove the current `.admin-main-content` scroll contract.

- [ ] **Step 7: Run the stylesheet test and production build**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test app/globals.css.test.ts

  docker compose build web
  ```

  Expected: the stylesheet test passes and `next build` completes without a PostCSS or alias resolution error.

- [ ] **Step 8: Commit the foundation**

  Run:

  ```bash
  git add \
    apps/web/package.json \
    apps/web/postcss.config.mjs \
    apps/web/components.json \
    apps/web/tsconfig.json \
    apps/web/lib/utils.ts \
    apps/web/components/ui \
    apps/web/app/globals.css \
    apps/web/app/globals.css.test.ts \
    pnpm-lock.yaml
  git commit -m "feat(web): add shadcn design system foundation"
  ```

## Task 3: Build Tested Admin Compositions

**Files:**
- Create: `apps/web/components/admin/shared/admin-page-header.tsx`
- Create: `apps/web/components/admin/shared/admin-page-header.test.tsx`
- Create: `apps/web/components/admin/shared/list-toolbar.tsx`
- Create: `apps/web/components/admin/shared/list-toolbar.test.tsx`
- Create: `apps/web/components/admin/shared/status-badge.tsx`
- Create: `apps/web/components/admin/shared/status-badge.test.tsx`
- Create: `apps/web/components/admin/shared/confirm-action-dialog.tsx`
- Create: `apps/web/components/admin/shared/confirm-action-dialog.test.tsx`
- Create: `apps/web/components/admin/shared/async-content-state.tsx`
- Create: `apps/web/components/admin/shared/async-content-state.test.tsx`
- Create: `apps/web/components/admin/shared/table-loading-state.tsx`
- Create: `apps/web/components/admin/shared/table-loading-state.test.tsx`

- [ ] **Step 1: Write the failing header and status tests**

  Add `admin-page-header.test.tsx`:

  ```tsx
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it } from 'vitest';

  import { AdminPageHeader } from './admin-page-header';

  describe('AdminPageHeader', () => {
    it('renders one page heading, supporting context, and the primary action slot', () => {
      render(
        <AdminPageHeader
          title="靶场编排"
          description="管理可复用的演练蓝图"
          action={<button type="button">新建拓扑</button>}
        />,
      );

      expect(screen.getByRole('heading', { name: '靶场编排', level: 1 })).toBeTruthy();
      expect(screen.getByText('管理可复用的演练蓝图')).toBeTruthy();
      expect(screen.getByRole('button', { name: '新建拓扑' })).toBeTruthy();
    });
  });
  ```

  Add `status-badge.test.tsx`:

  ```tsx
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it } from 'vitest';

  import { StatusBadge } from './status-badge';

  describe('StatusBadge', () => {
    it('uses the published semantic variant and label', () => {
      render(<StatusBadge status="published" />);

      expect(screen.getByText('已发布')).toHaveAttribute('data-status', 'published');
    });

    it('uses the private semantic variant and label', () => {
      render(<StatusBadge status="private" />);

      expect(screen.getByText('私有')).toHaveAttribute('data-status', 'private');
    });
  });
  ```

- [ ] **Step 2: Run the two tests and verify they fail because the modules do not exist**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/shared/admin-page-header.test.tsx \
    components/admin/shared/status-badge.test.tsx
  ```

  Expected: FAIL with module resolution errors for `admin-page-header` and `status-badge`.

- [ ] **Step 3: Implement the header and status components**

  Create `admin-page-header.tsx`:

  ```tsx
  import type { ReactNode } from 'react';

  type AdminPageHeaderProps = {
    title: string;
    description?: string;
    action?: ReactNode;
  };

  export function AdminPageHeader({ title, description, action }: AdminPageHeaderProps) {
    return (
      <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
    );
  }
  ```

  Create `status-badge.tsx`:

  ```tsx
  import { Badge } from '@/components/ui/badge';

  type TemplateStatus = 'published' | 'private';

  const statusConfig: Record<TemplateStatus, { label: string; className: string }> = {
    published: {
      label: '已发布',
      className: 'border-transparent bg-emerald-50 text-emerald-700',
    },
    private: {
      label: '私有',
      className: 'border-transparent bg-slate-100 text-slate-700',
    },
  };

  export function StatusBadge({ status }: { status: TemplateStatus }) {
    const config = statusConfig[status];

    return (
      <Badge data-status={status} variant="outline" className={config.className}>
        {config.label}
      </Badge>
    );
  }
  ```

- [ ] **Step 4: Write the failing toolbar, confirmation, and loading-state tests**

  Add `list-toolbar.test.tsx`:

  ```tsx
  import { fireEvent, render, screen } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';

  import { ListToolbar } from './list-toolbar';

  describe('ListToolbar', () => {
    it('forwards search text and switches the active topology view', () => {
      const onSearchChange = vi.fn();
      const onViewChange = vi.fn();

      render(
        <ListToolbar
          searchValue=""
          activeView="mine"
          onSearchChange={onSearchChange}
          onViewChange={onViewChange}
        />,
      );

      fireEvent.change(screen.getByRole('searchbox', { name: '筛选靶场名' }), {
        target: { value: '办公网' },
      });
      fireEvent.click(screen.getByRole('tab', { name: '平台拓扑' }));

      expect(onSearchChange).toHaveBeenCalledWith('办公网');
      expect(onViewChange).toHaveBeenCalledWith('platform');
    });
  });
  ```

  Add `confirm-action-dialog.test.tsx`:

  ```tsx
  import { fireEvent, render, screen } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';

  import { ConfirmActionDialog } from './confirm-action-dialog';

  describe('ConfirmActionDialog', () => {
    it('requires explicit confirmation before invoking a destructive action', () => {
      const onConfirm = vi.fn();
      const onOpenChange = vi.fn();

      render(
        <ConfirmActionDialog
          open
          title="删除靶场"
          description="企业攻防靶场将被删除。"
          confirmLabel="删除靶场"
          pending={false}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      fireEvent.click(screen.getByRole('button', { name: '删除靶场' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
  ```

  Add `table-loading-state.test.tsx`:

  ```tsx
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it } from 'vitest';

  import { Table, TableBody } from '@/components/ui/table';
  import { TableLoadingState } from './table-loading-state';

  describe('TableLoadingState', () => {
    it('keeps a stable accessible loading region with the requested row count', () => {
      render(
        <Table>
          <TableBody>
            <TableLoadingState columnCount={6} rowCount={4} label="正在加载靶场列表" />
          </TableBody>
        </Table>,
      );

      expect(screen.getByRole('status', { name: '正在加载靶场列表' })).toBeTruthy();
      expect(screen.getAllByTestId('table-loading-row')).toHaveLength(4);
    });
  });
  ```

  Add `async-content-state.test.tsx`:

  ```tsx
  import { fireEvent, render, screen } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';

  import { AsyncContentState } from './async-content-state';

  describe('AsyncContentState', () => {
    it('offers an explicit retry from an error state', () => {
      const onRetry = vi.fn();

      render(
        <AsyncContentState
          description="靶场编排加载失败，请刷新页面后重试。"
          onRetry={onRetry}
          title="无法加载靶场列表"
          variant="error"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] **Step 5: Run the tests and verify they fail because the three modules do not exist**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/shared/list-toolbar.test.tsx \
    components/admin/shared/confirm-action-dialog.test.tsx \
    components/admin/shared/async-content-state.test.tsx \
    components/admin/shared/table-loading-state.test.tsx
  ```

  Expected: FAIL with module resolution errors for the three new components.

- [ ] **Step 6: Implement the toolbar, confirmation, and loading state**

  Create `list-toolbar.tsx`:

  ```tsx
  import { Search } from 'lucide-react';

  import { Input } from '@/components/ui/input';
  import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

  type TemplateView = 'mine' | 'platform';

  type ListToolbarProps = {
    searchValue: string;
    activeView: TemplateView;
    onSearchChange: (value: string) => void;
    onViewChange: (view: TemplateView) => void;
  };

  export function ListToolbar({
    searchValue,
    activeView,
    onSearchChange,
    onViewChange,
  }: ListToolbarProps) {
    return (
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="筛选靶场名"
            className="pl-9"
            placeholder="搜索靶场名"
            type="search"
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        <Tabs value={activeView} onValueChange={(value) => onViewChange(value as TemplateView)}>
          <TabsList aria-label="靶场编排视图">
            <TabsTrigger value="mine">我的拓扑</TabsTrigger>
            <TabsTrigger value="platform">平台拓扑</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    );
  }
  ```

  Create `confirm-action-dialog.tsx`:

  ```tsx
  import { Button } from '@/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '@/components/ui/dialog';

  type ConfirmActionDialogProps = {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    pending: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  };

  export function ConfirmActionDialog({
    open,
    title,
    description,
    confirmLabel,
    pending,
    onOpenChange,
    onConfirm,
  }: ConfirmActionDialogProps) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  ```

  Create `table-loading-state.tsx`:

  ```tsx
  import { Skeleton } from '@/components/ui/skeleton';
  import { TableCell, TableRow } from '@/components/ui/table';

  type TableLoadingStateProps = {
    columnCount: number;
    rowCount: number;
    label: string;
  };

  export function TableLoadingState({ columnCount, rowCount, label }: TableLoadingStateProps) {
    return (
      <>
        {Array.from({ length: rowCount }, (_, rowIndex) => (
          <TableRow
            key={rowIndex}
            data-testid="table-loading-row"
          >
            {Array.from({ length: columnCount }, (_, columnIndex) => (
              <TableCell key={columnIndex}>
                {rowIndex === 0 && columnIndex === 0 ? (
                  <span aria-label={label} className="sr-only" role="status">
                    {label}
                  </span>
                ) : null}
                <Skeleton className="h-4 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </>
    );
  }
  ```

  Create `async-content-state.tsx`:

  ```tsx
  import type { ReactNode } from 'react';

  import { Button } from '@/components/ui/button';

  type AsyncContentStateProps = {
    title: string;
    description: string;
    variant: 'empty' | 'error';
    action?: ReactNode;
    onRetry?: () => void;
  };

  export function AsyncContentState({
    title,
    description,
    variant,
    action,
    onRetry,
  }: AsyncContentStateProps) {
    return (
      <div className="grid min-h-48 place-items-center border border-dashed border-border px-6 py-10 text-center">
        <div className="max-w-md">
          <strong className="text-sm text-foreground">{title}</strong>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          <div className="mt-4 flex justify-center gap-2">
            {variant === 'error' && onRetry ? <Button onClick={onRetry}>重试加载</Button> : null}
            {action}
          </div>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 7: Re-run all admin shared component tests**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/shared/admin-page-header.test.tsx \
    components/admin/shared/status-badge.test.tsx \
    components/admin/shared/list-toolbar.test.tsx \
    components/admin/shared/confirm-action-dialog.test.tsx \
    components/admin/shared/async-content-state.test.tsx \
    components/admin/shared/table-loading-state.test.tsx
  ```

  Expected: PASS. The confirmation test must call `onConfirm` exactly once, the toolbar test must preserve controlled state, and the async error state must call `onRetry` exactly once.

- [ ] **Step 8: Commit the shared layer**

  Run:

  ```bash
  git add apps/web/components/admin/shared
  git commit -m "feat(web): add reusable admin interface components"
  ```

## Task 4: Migrate The Admin Workspace Shell

**Files:**
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add the failing narrow-navigation test**

  Add this test to `admin-workspace-shell.test.tsx`:

  ```tsx
  it('opens the same navigation entries from the compact navigation control', async () => {
    writeAdminSession(createSession());

    render(
      <AdminWorkspaceShell>
        <div>workspace content</div>
      </AdminWorkspaceShell>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '打开导航' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('link', { name: /靶场编排/i }).getAttribute('href')).toBe('/admin/scenarios');
    expect(screen.getByRole('link', { name: /基础配置/i }).getAttribute('href')).toBe('/admin/settings/cloud');
  });
  ```

  Add `fireEvent` to the existing Testing Library import.

- [ ] **Step 2: Run the shell test and verify it fails because the compact navigation control does not exist**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/admin-workspace-shell.test.tsx \
    --testNamePattern "opens the same navigation"
  ```

  Expected: FAIL because no button has the accessible name `打开导航`.

- [ ] **Step 3: Add a pure navigation renderer and responsive sheet**

  In `admin-workspace-shell.tsx`, introduce:

  ```tsx
  import { Menu, PanelLeftClose } from 'lucide-react';

  import { Button } from '@/components/ui/button';
  import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
  import { cn } from '@/lib/utils';
  ```

  Extract `AdminNavigation` with this interface:

  ```tsx
  type NavigationItem = {
    href: string;
    label: string;
    shortLabel: string;
  };

  function AdminNavigation({
    items,
    pathname,
    onNavigate,
  }: {
    items: NavigationItem[];
    pathname: string;
    onNavigate?: () => void;
  }) {
    return (
      <nav aria-label="后台导航" className="grid gap-1">
        {items.map((item) => (
          <Link
            key={item.href}
            className={cn(
              'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
              isNavigationItemActive(pathname, item.href) && 'bg-accent text-accent-foreground',
            )}
            href={item.href}
            onClick={onNavigate}
          >
            <span className="grid size-6 place-items-center rounded bg-background text-[10px] font-semibold text-primary">
              {item.shortLabel}
            </span>
            {item.label}
          </Link>
        ))}
      </nav>
    );
  }
  ```

  Render this responsive control before the existing top-bar metadata:

  ```tsx
  <Sheet>
    <SheetTrigger asChild>
      <Button aria-label="打开导航" className="lg:hidden" size="icon" variant="ghost">
        <Menu aria-hidden="true" />
      </Button>
    </SheetTrigger>
    <SheetContent side="left">
      <SheetTitle>综合靶场平台</SheetTitle>
      <div className="mt-6">
        <AdminNavigation items={visibleNavigationItems} pathname={pathname} />
      </div>
    </SheetContent>
  </Sheet>
  ```

  Use `AdminNavigation` in the desktop `<aside>` too. Keep every session refresh effect and redirect branch exactly as it is.

- [ ] **Step 4: Replace only the shell's visual layout rules**

  Add scoped transition CSS to `globals.css`:

  ```css
  .admin-workspace {
    min-height: 100dvh;
    background: var(--background);
  }

  .admin-sidebar {
    width: 198px;
    border-right: 1px solid var(--border);
    background: var(--card);
  }

  @media (max-width: 1023px) {
    .admin-sidebar {
      display: none;
    }
  }
  ```

  Preserve the existing `.admin-main-shell`, `.admin-main-content`, and scrollbar selectors so the current scroll ownership tests keep passing.

- [ ] **Step 5: Run shell and stylesheet tests**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/admin-workspace-shell.test.tsx \
    app/globals.css.test.ts
  ```

  Expected: PASS. Existing role filtering, login/callback bypass, logout, and session renewal tests remain green.

- [ ] **Step 6: Commit the shell migration**

  Run:

  ```bash
  git add \
    apps/web/components/admin/admin-workspace-shell.tsx \
    apps/web/components/admin/admin-workspace-shell.test.tsx \
    apps/web/app/globals.css
  git commit -m "feat(web): refresh the admin workspace shell"
  ```

## Task 5: Migrate The Range Template Workbench Presentation

**Files:**
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/admin-pagination.tsx`
- Modify: `apps/web/components/admin/admin-pagination.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Update the existing template screen test to express the new semantic surface**

  In the first test in `templates-screen.test.tsx`, replace CSS-grid assertions with:

  ```tsx
  expect(screen.getByRole('heading', { name: '靶场编排', level: 1 })).toBeTruthy();
  expect(screen.getByRole('tablist', { name: '靶场编排视图' })).toBeTruthy();
  expect(screen.getByRole('searchbox', { name: '筛选靶场名' })).toBeTruthy();
  expect(screen.getByRole('table', { name: '靶场列表' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '靶场' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '创建人' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '靶场描述' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '拓扑概览' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '状态' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy();
  expect(within(screen.getByRole('row', { name: /企业攻防靶场/ })).getByText('已发布')).toHaveAttribute(
    'data-status',
    'published',
  );
  ```

  Add a test:

  ```tsx
  it('keeps low-frequency template actions inside the action menu', async () => {
    fetchRangeTemplatesMock.mockResolvedValue(bootstrapPayload.rangeTemplates);
    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('企业攻防靶场');
    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]!);

    expect(screen.getByRole('menuitem', { name: '编辑信息' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除模板' })).toBeTruthy();
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails against the current div-grid markup**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/templates-screen.test.tsx \
    --testNamePattern "renders the scenario workbench|keeps low-frequency"
  ```

  Expected: FAIL because no element has `role="table"` and the custom action menu does not expose `menuitem` roles.

- [ ] **Step 3: Replace only the screen presentation primitives**

  In `templates-screen.tsx`, import:

  ```tsx
  import { MoreHorizontal, Plus } from 'lucide-react';

  import { Button } from '@/components/ui/button';
  import { Label } from '@/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '@/components/ui/dialog';
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from '@/components/ui/dropdown-menu';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@/components/ui/table';
  import { AdminPageHeader } from './shared/admin-page-header';
  import { AsyncContentState } from './shared/async-content-state';
  import { ConfirmActionDialog } from './shared/confirm-action-dialog';
  import { ListToolbar } from './shared/list-toolbar';
  import { StatusBadge } from './shared/status-badge';
  import { TableLoadingState } from './shared/table-loading-state';
  ```

  Replace the `template-workbench-list-header`, controls, column-head, and row markup with this structure:

  ```tsx
  <section className="rounded-md border border-border bg-card p-4 shadow-sm">
    <AdminPageHeader
      title="靶场编排"
      description="管理可复用的演练蓝图"
      action={
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus aria-hidden="true" />
          新建拓扑
        </Button>
      }
    />
    <div className="mt-4">
      <ListToolbar
        activeView={activeView}
        searchValue={searchName}
        onSearchChange={setSearchName}
        onViewChange={setActiveViewWithUrl}
      />
    </div>
    <div className="mt-4 overflow-x-auto">
      <Table aria-label="靶场列表">
        <TableHeader>
          <TableRow>
            <TableHead>靶场</TableHead>
            <TableHead>创建人</TableHead>
            <TableHead>靶场描述</TableHead>
            <TableHead>拓扑概览</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isBootstrapLoading ? (
            <TableLoadingState columnCount={6} label="正在加载靶场列表" rowCount={pageSize} />
          ) : (
            pagedTemplates.map((template) => (
            <TableRow key={template.id}>
              <TableCell className="font-medium">{getScenarioDisplayName(template)}</TableCell>
              <TableCell>{template.createdBy?.trim() || 'admin'}</TableCell>
              <TableCell className="max-w-72 whitespace-normal text-muted-foreground">
                {getScenarioDescription(template)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>区域 {readZoneCount(template)}</span>
                  <span>主机 {readHostCount(template)}</span>
                  <span>节点 {readNodeCount(template)}</span>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={isPublishedScenario(template) ? 'published' : 'private'} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  disabled={isSubmitting || !canEnterTemplate}
                  size="sm"
                  onClick={() => void handleOpenTemplateEditor(template)}
                >
                  进入编排
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="更多操作" disabled={isSubmitting} size="icon" variant="ghost">
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void handleCloneTemplate(template)}>复制模板</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openEditDialog(template)}>编辑信息</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void handleOpenGenerateInstance(template)}>生成实例</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openConfirmDialog('delete', template)}>删除模板</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  </section>
  ```

  Preserve the existing permission predicates. Only render `DropdownMenuItem` entries when their existing conditions allow them. Keep `handleCreateTemplate`, `handleUpdateTemplate`, `handleShareTemplate`, `handleUnshareTemplate`, `handleCloneTemplate`, `handleOpenGenerateInstance`, `handleLaunchInstance`, and delete handlers unchanged.

- [ ] **Step 4: Add retryable error and relevant empty-state behavior**

  Add a `loadAttempt` counter beside the existing template view state:

  ```tsx
  const [loadAttempt, setLoadAttempt] = useState(0);

  function retryActiveView() {
    setErrorMessage(null);
    setLoadedViews((current) => ({
      ...current,
      [activeView]: false,
    }));
    setLoadAttempt((current) => current + 1);
  }
  ```

  Add `loadAttempt` to the existing data-fetching effect dependency array. Replace the current standalone `errorMessage` paragraph with:

  ```tsx
  {errorMessage ? (
    <AsyncContentState
      description={errorMessage}
      onRetry={retryActiveView}
      title="无法加载靶场列表"
      variant="error"
    />
  ) : null}
  ```

  Replace the no-results block with:

  ```tsx
  <AsyncContentState
    action={
      activeView === 'mine' ? (
        <Button onClick={() => setIsCreateDialogOpen(true)}>新建拓扑</Button>
      ) : undefined
    }
    description={
      activeView === 'mine'
        ? '你可以新建一个靶场并开始编排。'
        : '平台暂时没有可用的已发布拓扑。'
    }
    title="当前筛选条件下没有靶场"
    variant="empty"
  />
  ```

  Add this test to `templates-screen.test.tsx`:

  ```tsx
  it('retries the active template view after a load failure', async () => {
    fetchRangeTemplatesMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(bootstrapPayload.rangeTemplates);

    render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '重试加载' }));

    expect(await screen.findByText('企业攻防靶场')).toBeTruthy();
    expect(fetchRangeTemplatesMock).toHaveBeenCalledTimes(2);
  });
  ```

- [ ] **Step 5: Replace the four custom dialogs with shared dialog primitives**

  Use `Dialog` for create, edit, and launch. The submit handlers remain the current screen handlers:

  ```tsx
  <Dialog open={isCreateDialogOpen} onOpenChange={(open) => (open ? setIsCreateDialogOpen(true) : closeCreateDialog())}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>创建靶场</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="create-template-name">靶场名</Label>
          <Input
            id="create-template-name"
            value={createDraft.name}
            onChange={(event) =>
              setCreateDraft((previous) => ({ ...previous, name: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="create-template-description">靶场描述</Label>
          <Input
            id="create-template-description"
            value={createDraft.description}
            onChange={(event) =>
              setCreateDraft((previous) => ({ ...previous, description: event.target.value }))
            }
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={isSubmitting} variant="outline" onClick={closeCreateDialog}>
          取消
        </Button>
        <Button disabled={isSubmitting} onClick={() => void handleCreateTemplate()}>
          创建并进入编排
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  ```

  Use `ConfirmActionDialog` for the delete confirmation:

  ```tsx
  <ConfirmActionDialog
    confirmLabel="删除模板"
    description={`删除“${confirmState.template.name ?? confirmState.template.slug}”后无法恢复。`}
    onConfirm={() => void handleDeleteTemplate(confirmState.template.id)}
    onOpenChange={(open) => {
      if (!open) {
        closeConfirmDialog();
      }
    }}
    open={confirmState?.type === 'delete'}
    pending={isSubmitting}
    title="删除靶场"
  />
  ```

  Keep the existing conflict-specific delete guidance in the dialog description when `getDeleteTemplateConflictMessage` returns a message.

- [ ] **Step 6: Adapt pagination without changing its state contract**

  Keep `getPagination`, `buildVisiblePages`, `useAdminPageSize`, and the `AdminPaginationControls` props unchanged. Replace only native controls in `admin-pagination.tsx` with `Button` and `Select` primitives while preserving these accessible labels:

  ```text
  每页条数
  上一页
  下一页
  第 {pageNumber} 页
  跳转到页码
  跳转
  ```

  The current `admin-pagination.test.tsx` must pass unchanged after the visual conversion.

- [ ] **Step 7: Re-run template and pagination regressions**

  Run:

  ```bash
  docker compose run --no-deps --rm --build web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/templates-screen.test.tsx \
    components/admin/admin-pagination.test.tsx
  ```

  Expected: PASS. The tests must still cover view persistence, user ownership restrictions, cloning, publishing, unpublishing, launching, delete confirmation, and conflict messages.

- [ ] **Step 8: Commit the list migration**

  Run:

  ```bash
  git add \
    apps/web/components/admin/templates-screen.tsx \
    apps/web/components/admin/templates-screen.test.tsx \
    apps/web/components/admin/admin-pagination.tsx \
    apps/web/components/admin/admin-pagination.test.tsx \
    apps/web/app/globals.css
  git commit -m "feat(web): refresh the range template workbench"
  ```

## Task 6: Verify The Merged Frontend In Containers

**Files:**
- Modify only if a verification reveals a defect in a file listed by Tasks 1 through 5.

- [ ] **Step 1: Build the final web image**

  Run:

  ```bash
  docker compose build web
  ```

  Expected: `next build` succeeds. Record the `First Load JS` values for `/admin/scenarios`, `/admin/scenarios/[scenarioId]`, and `/admin/ranges/[rangeId]`.

- [ ] **Step 2: Run the complete web test suite in the final image**

  Run:

  ```bash
  docker compose run --no-deps --rm web \
    pnpm --filter @aliyun-cyber-range/web test
  ```

  Expected: PASS with no `React.act is not a function` failure.

- [ ] **Step 3: Recreate only the frontend service**

  Run:

  ```bash
  docker compose up --no-deps --no-build --force-recreate --detach web
  curl --fail --retry 5 --retry-all-errors --retry-delay 1 \
    --silent --show-error --output /dev/null \
    http://localhost:3000/admin/login
  ```

  Expected: the web service restarts and the login route returns HTTP 200. Do not recreate API, worker, database, or identity services.

- [ ] **Step 4: Perform desktop and narrow-browser checks**

  Run:

  ```bash
  export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
  "$PWCLI" open http://localhost:3000/admin/login
  "$PWCLI" snapshot
  "$PWCLI" resize 1440 960
  "$PWCLI" screenshot
  "$PWCLI" resize 390 844
  "$PWCLI" screenshot
  "$PWCLI" console error
  "$PWCLI" close
  ```

  Expected: login content fits both viewports, the browser reports no console errors, and the mobile menu control is visible on the narrow viewport after authentication.

- [ ] **Step 5: Confirm deferred topology modules remain deferred**

  Run:

  ```bash
  docker compose run --no-deps --rm web \
    pnpm --filter @aliyun-cyber-range/web test \
    components/admin/loading-boundaries.test.tsx

  deferred_chunk="$(
    docker exec "$(docker compose ps -q web)" sh -lc \
      "find /app/apps/web/.next/static/chunks -type f -name '*.js' -exec grep -l '选择节点后配置' {} \; | head -1 | xargs -n1 basename"
  )"
  test -n "$deferred_chunk"

  for route in /admin/ranges/range-1 /admin/scenarios/template-1; do
    if curl -fsS "http://localhost:3000$route" | rg -F "$deferred_chunk"; then
      exit 1
    fi
  done
  ```

  Expected: the loading-boundary test passes, a deferred property-panel chunk is found in the built assets, and no direct route HTML response preloads that chunk.

- [ ] **Step 6: Commit any verification-only correction**

  If a defect was fixed during Task 6, commit the application change:

  ```bash
  git add apps/web
  git commit -m "fix(web): correct design system regression"
  ```

  If no defect is found, do not create an empty commit.

## Plan Self-Review

### Spec Coverage

- Tailwind v4, shadcn/Radix, aliases, Lucide, and project-owned primitives: Task 2.
- App-local UI and platform composition boundaries: Task 3.
- Responsive stable workspace shell without session or permission changes: Task 4.
- Range-template list, tab lazy-loading, table, status, menus, dialogs, pagination, loading, retryable error, and relevant empty presentation: Task 5.
- Test-first behavior coverage, Docker-only build and verification, route-size observation, browser checks, and deferred topology protection: Tasks 1 through 6.

### Placeholder Scan

The plan contains no unresolved decisions, broad implementation instructions, or omitted command sequences. Generated shadcn primitive source is intentionally created by the documented CLI command, which is the supported source of those files.

### Type Consistency

`TemplateView` is constrained to `mine | platform`, `StatusBadge` accepts `published | private`, and the shared component imports use the `@/*` alias established in Task 2. The template screen continues to own every existing mutation handler and passes callbacks into presentation components.
