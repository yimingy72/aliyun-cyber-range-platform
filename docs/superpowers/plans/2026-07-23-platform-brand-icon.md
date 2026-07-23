# 平台品牌图标与 Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理后台侧栏和移动导航中展示结构盾牌平台标识，并让浏览器标签页加载同一标识导出的 `.ico` favicon。

**Architecture:** 静态 SVG 是侧栏显示的唯一图形资源；`PlatformBrand` 组件负责图标、名称与尺寸，不让品牌标记散落在壳层 JSX 中。`favicon.ico` 从同一 SVG 生成多个尺寸并由根布局的 Next.js metadata 显式声明。

**Tech Stack:** Next.js App Router、React 19、TypeScript、Tailwind CSS、Vitest、macOS `sips`、Node.js `Buffer`、Docker Compose。

---

## 文件结构

- Create: `apps/web/public/brand/platform-mark.svg`  
  64px 结构盾牌主图形，作为侧栏与抽屉标识的静态资源。
- Create: `apps/web/components/admin/platform-brand.tsx`  
  平台名称与图标的可复用展示组件，提供默认和紧凑尺寸。
- Create: `apps/web/components/admin/platform-brand.test.tsx`  
  验证品牌组件的名称、资源路径与尺寸。
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`  
  使用品牌组件替换桌面侧栏与移动抽屉中硬编码的平台名称。
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`  
  验证两个壳层位置都复用同一品牌标识。
- Create: `apps/web/app/favicon.ico`  
  包含 16px、32px、48px PNG 图像条目的浏览器 favicon。
- Modify: `apps/web/app/layout.tsx`  
  在 `metadata.icons` 中显式声明 `/favicon.ico`。
- Create: `apps/web/app/layout.test.ts`  
  验证 favicon metadata 与 `.ico` 文件头、尺寸条目。

### Task 1: 平台品牌组件与 SVG 资源

**Files:**
- Create: `apps/web/public/brand/platform-mark.svg`
- Create: `apps/web/components/admin/platform-brand.tsx`
- Create: `apps/web/components/admin/platform-brand.test.tsx`

- [ ] **Step 1: 为品牌组件写失败测试**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlatformBrand } from './platform-brand';

describe('PlatformBrand', () => {
  it('renders the platform name and the canonical shield asset at the desktop size', () => {
    render(<PlatformBrand />);

    expect(screen.getByText('综合靶场平台')).toBeTruthy();
    expect(screen.getByTestId('platform-brand-mark')).toHaveAttribute('src', '/brand/platform-mark.svg');
    expect(screen.getByTestId('platform-brand-mark').className).toContain('size-7');
  });

  it('uses the compact mark size for the navigation drawer', () => {
    render(<PlatformBrand compact />);

    expect(screen.getByTestId('platform-brand-mark').className).toContain('size-6');
  });
});
```

- [ ] **Step 2: 在 Docker 容器中运行测试并确认它失败**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/platform-brand.test.tsx
```

Expected: FAIL，原因是 `./platform-brand` 尚不存在。

- [ ] **Step 3: 创建结构盾牌 SVG**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect x="2" y="2" width="60" height="60" rx="16" fill="#1D56A7"/>
  <path d="M20 16H44V30C44 40.2 37.5 46.3 32 49C26.5 46.3 20 40.2 20 30V16Z" stroke="white" stroke-width="4" stroke-linejoin="round"/>
  <rect x="26" y="25" width="12" height="9" rx="2" stroke="white" stroke-width="3"/>
</svg>
```

Save it as `apps/web/public/brand/platform-mark.svg`. The 60px blue rounded square preserves contrast in a dark browser tab, and the shield outline remains legible after favicon downscaling.

- [ ] **Step 4: 创建可复用品牌组件**

```tsx
import { cn } from '@/lib/utils';

type PlatformBrandProps = {
  className?: string;
  compact?: boolean;
};

export function PlatformBrand({ className, compact = false }: PlatformBrandProps) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2.5 text-sm text-foreground', className)}
      data-slot="platform-brand"
    >
      <img
        alt=""
        aria-hidden="true"
        className={cn('shrink-0', compact ? 'size-6' : 'size-7')}
        data-testid="platform-brand-mark"
        height={compact ? 24 : 28}
        src="/brand/platform-mark.svg"
        width={compact ? 24 : 28}
      />
      <span className="truncate font-semibold">综合靶场平台</span>
    </span>
  );
}
```

The wrapper is a `span`, so it can safely be used inside Radix `SheetTitle` without placing a block element inside the title heading.

- [ ] **Step 5: 在 Docker 容器中运行组件测试并确认通过**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/platform-brand.test.tsx
```

Expected: PASS，2 tests passed.

- [ ] **Step 6: 提交品牌资源与组件**

```bash
git add apps/web/public/brand/platform-mark.svg \
  apps/web/components/admin/platform-brand.tsx \
  apps/web/components/admin/platform-brand.test.tsx
git commit -m "feat(web): add platform brand mark"
```

### Task 2: 将品牌组件接入桌面侧栏与移动导航

**Files:**
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx:10-16,262-286`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx:173-214`

- [ ] **Step 1: 扩展壳层测试，先验证两个品牌展示位置**

Add this assertion to `opens the compact navigation drawer` immediately after resolving `navigationDialog`:

```tsx
const drawerBrand = within(navigationDialog).getByTestId('platform-brand');
expect(within(drawerBrand).getByTestId('platform-brand-mark').className).toContain('size-6');
```

Add this assertion to `shows the admin navigation, including 用户管理 and 账单费用, for admin sessions` after finding `workspace content`:

```tsx
const sidebarBrand = screen.getByTestId('admin-sidebar-brand');
expect(within(sidebarBrand).getByTestId('platform-brand-mark')).toHaveAttribute('src', '/brand/platform-mark.svg');
```

- [ ] **Step 2: 在 Docker 容器中运行壳层测试并确认它失败**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx
```

Expected: FAIL，`admin-sidebar-brand` 与抽屉中的 `platform-brand` 尚未渲染。

- [ ] **Step 3: 用品牌组件替换壳层中的硬编码标题**

Add this import below the existing local component imports:

```tsx
import { PlatformBrand } from './platform-brand';
```

Replace the desktop sidebar heading with:

```tsx
<div className="border-b border-border px-5 py-[18px]" data-testid="admin-sidebar-brand">
  <PlatformBrand />
</div>
```

Replace the mobile drawer title with:

```tsx
<SheetTitle className="leading-none">
  <PlatformBrand compact />
</SheetTitle>
```

The desktop heading remains 64px high (`18px` vertical padding plus the 28px mark), so the navigation’s existing vertical anchor does not shift.

- [ ] **Step 4: 在 Docker 容器中运行壳层测试并确认通过**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/platform-brand.test.tsx
```

Expected: PASS，existing session/navigation tests and the new brand tests all pass.

- [ ] **Step 5: 提交壳层接入**

```bash
git add apps/web/components/admin/admin-workspace-shell.tsx \
  apps/web/components/admin/admin-workspace-shell.test.tsx
git commit -m "feat(web): show platform mark in workspace navigation"
```

### Task 3: 生成并声明多尺寸 `.ico` Favicon

**Files:**
- Create: `apps/web/app/favicon.ico`
- Create: `apps/web/app/layout.test.ts`
- Modify: `apps/web/app/layout.tsx:6-9`

- [ ] **Step 1: 编写 favicon metadata 与文件格式的失败测试**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('root metadata', () => {
  it('declares the ICO favicon and ships 16px, 32px, and 48px icon entries', () => {
    expect(metadata.icons).toMatchObject({ icon: '/favicon.ico' });

    const icon = readFileSync(fileURLToPath(new URL('./favicon.ico', import.meta.url)));
    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(icon.readUInt16LE(4)).toBe(3);

    const entryWidths = [6, 22, 38].map((offset) => icon[offset]);
    expect(entryWidths).toEqual([16, 32, 48]);
  });
});
```

- [ ] **Step 2: 在 Docker 容器中运行 metadata 测试并确认它失败**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  app/layout.test.ts
```

Expected: FAIL，`favicon.ico` 不存在且 metadata 未声明 icons。

- [ ] **Step 3: 从 canonical SVG 生成多尺寸 ICO**

Run these commands from the repository root. The temporary PNGs are not committed; `favicon.ico` is the committed browser asset.

```bash
tmp_dir="$(mktemp -d)"
for size in 16 32 48; do
  sips -s format png -z "$size" "$size" \
    apps/web/public/brand/platform-mark.svg \
    --out "$tmp_dir/platform-mark-$size.png"
done

node - "$tmp_dir" apps/web/app/favicon.ico <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');

const [sourceDir, outputPath] = process.argv.slice(2);
const sizes = [16, 32, 48];
const pngs = sizes.map((size) => readFileSync(`${sourceDir}/platform-mark-${size}.png`));
const directoryLength = 6 + pngs.length * 16;
const header = Buffer.alloc(directoryLength);

header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);

let offset = directoryLength;
pngs.forEach((png, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index];
  header[entry + 1] = sizes[index];
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});

writeFileSync(outputPath, Buffer.concat([header, ...pngs]));
NODE

rm -rf "$tmp_dir"
file apps/web/app/favicon.ico
```

Expected final command output: `MS Windows icon resource`, with 16px, 32px, and 48px image entries.

- [ ] **Step 4: 显式声明根布局图标 metadata**

Update `metadata` in `apps/web/app/layout.tsx` to:

```tsx
export const metadata: Metadata = {
  title: '云上综合靶场平台',
  description: '面向内部安全演练管理员的云上综合靶场编排与实例管理平台',
  icons: {
    icon: '/favicon.ico',
  },
};
```

- [ ] **Step 5: 在 Docker 容器中运行 favicon 测试并确认通过**

Run:

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  app/layout.test.ts
```

Expected: PASS，ICO 头、3 个图像条目与 metadata 声明均正确。

- [ ] **Step 6: 提交 favicon**

```bash
git add apps/web/app/favicon.ico \
  apps/web/app/layout.tsx \
  apps/web/app/layout.test.ts
git commit -m "feat(web): add platform favicon"
```

### Task 4: 容器态构建、视觉验收与交付

**Files:**
- Verify only: files changed by Tasks 1-3

- [ ] **Step 1: 构建 Web 镜像**

```bash
docker compose -p for build web
```

Expected: `for-web Built` and Next.js completes its type check.

- [ ] **Step 2: 运行相关前端测试**

```bash
docker compose -p for run --no-deps --rm web \
  pnpm --filter @aliyun-cyber-range/web test \
  components/admin/platform-brand.test.tsx \
  components/admin/admin-workspace-shell.test.tsx \
  app/layout.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 3: 仅替换 Web 容器**

```bash
docker compose -p for up -d --no-deps --force-recreate web
docker compose -p for ps web
```

Expected: `for-web-1` is up on port 3000; API, worker, database, and Keycloak are not recreated.

- [ ] **Step 4: 视觉检查桌面侧栏、移动抽屉与浏览器 favicon**

Use the existing authenticated administrator session against `http://localhost:3000/admin/image-center`:

1. Capture a desktop screenshot and verify the 28px shield is left of “综合靶场平台”, aligned inside the existing 64px sidebar heading.
2. Open the compact navigation drawer and verify the same 24px mark appears in the drawer title.
3. Open `http://localhost:3000/favicon.ico` in a browser tab and verify the blue shield displays rather than a generic document icon.
4. Save screenshots under `output/playwright/platform-brand-icon/`; do not add generated screenshots to Git.

- [ ] **Step 5: Final integrity check and commit validation**

```bash
git diff --check
git status --short
git log --oneline -3
```

Expected: no whitespace errors; only the three focused feature commits are present on `codex/platform-brand-icon`.
