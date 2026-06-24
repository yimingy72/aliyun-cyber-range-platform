# 管理后台与登录体验重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前英文占位页和单文件后台改造成正式的中文登录体系与控制台型管理后台，并保留现有后台对象管理与编排操作能力。

**Architecture:** Web 端按 Next.js App Router 的真实路由拆成 `/login`、`/admin/login`、`/admin`、`/admin/range-instances`、`/admin/provision-jobs`、`/admin/settings` 六个页面；共享认证、API 调用和后台导航从旧的 `AdminConsole` 单文件中抽离出来。后端只补一个最小只读云配置接口，避免“基础配置 / 云配置”页只能展示假数据。

**Tech Stack:** Next.js 15 App Router、React 19、Vitest + Testing Library、NestJS 11、Jest + Supertest、现有 Admin REST API

---

## 范围说明

这份计划只覆盖已批准的《后台体验设计文档》：

- 根路由重定向
- 选手登录页
- 管理员登录页
- 中文后台与一级导航
- 靶场总览 / 靶场实例 / 编排任务 / 基础配置
- 最小只读云配置接口

这份计划**不包含**：

- `api/web/db` Dockerfile 与完整 compose 重构
- 阿里云综合靶场完整真实联调
- 选手端完整产品

这三项应在本计划执行完成后，继续进入后续单独计划。

## 代码结构预定稿

### Web 路由层

- Modify: `apps/web/app/page.tsx`
  - 根路径不再显示英文 hero，改为服务端重定向到 `/login`
- Create: `apps/web/app/login/page.tsx`
  - 选手登录正式入口页
- Create: `apps/web/app/admin/login/page.tsx`
  - 管理员独立登录页
- Create: `apps/web/app/admin/layout.tsx`
  - 后台共享导航与登录态守卫容器
- Modify: `apps/web/app/admin/page.tsx`
  - 后台首页改为靶场总览页
- Create: `apps/web/app/admin/range-instances/page.tsx`
  - 靶场实例页
- Create: `apps/web/app/admin/provision-jobs/page.tsx`
  - 编排任务页
- Create: `apps/web/app/admin/settings/page.tsx`
  - 基础配置页

### Web 组件层

- Create: `apps/web/components/auth/player-login-screen.tsx`
  - 选手登录页面主体
- Create: `apps/web/components/auth/admin-login-screen.tsx`
  - 管理员登录表单与登录反馈
- Create: `apps/web/components/admin/admin-workspace-shell.tsx`
  - 后台导航框架、顶部栏、退出动作
- Create: `apps/web/components/admin/overview-screen.tsx`
  - 靶场总览内容
- Create: `apps/web/components/admin/range-instances-screen.tsx`
  - 实例列表、筛选、详情与 create/destroy 操作
- Create: `apps/web/components/admin/provision-jobs-screen.tsx`
  - 任务列表、步骤日志与失败信息
- Create: `apps/web/components/admin/settings/settings-screen.tsx`
  - 基础配置页容器与页内标签切换
- Create: `apps/web/components/admin/settings/competitions-panel.tsx`
- Create: `apps/web/components/admin/settings/teams-panel.tsx`
- Create: `apps/web/components/admin/settings/templates-panel.tsx`
- Create: `apps/web/components/admin/settings/cloud-config-panel.tsx`

### Web 共享逻辑层

- Create: `apps/web/lib/admin-types.ts`
  - 后台共享数据类型
- Create: `apps/web/lib/admin-api.ts`
  - 后台 REST API 调用封装
- Create: `apps/web/lib/admin-auth-storage.ts`
  - 登录 token 本地存储读写
- Create: `apps/web/components/admin/use-admin-session.ts`
  - 后台登录态恢复与路由守卫
- Modify: `apps/web/app/globals.css`
  - 中文正式产品风格的全局样式令牌与页面样式

### API 最小配套

- Create: `apps/api/src/admin/system-config.service.ts`
  - 读取最小云配置快照
- Create: `apps/api/src/admin/system-config.controller.ts`
  - 提供 `/admin/system-config` 只读接口
- Modify: `apps/api/src/app.module.ts`
  - 注册 service/controller

### 过时代码清理

- Delete: `apps/web/app/admin/admin-console.tsx`
- Delete: `apps/web/app/admin/admin-console.test.tsx`

---

### Task 1: 根路由重定向与选手登录入口

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/page.test.tsx`
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/app/login/page.test.tsx`
- Create: `apps/web/components/auth/player-login-screen.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 先写失败测试，锁定根路由和选手入口**

```tsx
// apps/web/app/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn();

vi.mock('next/navigation', () => ({
  redirect,
}));

import HomePage from './page';

describe('HomePage', () => {
  it('redirects the root route to /login', () => {
    HomePage();
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
```

```tsx
// apps/web/app/login/page.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LoginPage from './page';

describe('LoginPage', () => {
  it('shows the player login page and admin entry link', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: '选手登录' })).toBeTruthy();
    expect(screen.getByText('综合靶场竞赛入口')).toBeTruthy();
    expect(screen.getByRole('link', { name: '管理员入口' }).getAttribute('href')).toBe('/admin/login');
  });
});
```

- [ ] **Step 2: 运行测试，确认它们先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- app/page.test.tsx app/login/page.test.tsx`

Expected: `FAIL`，其中一个失败来自 `redirect` 未被调用，另一个失败来自 `/login` 页面文件尚不存在。

- [ ] **Step 3: 实现根路由跳转、选手登录页和新的认证样式基线**

```tsx
// apps/web/app/page.tsx
import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/login');
}
```

```tsx
// apps/web/components/auth/player-login-screen.tsx
import Link from 'next/link';

type PlayerLoginScreenProps = {
  adminHref?: string;
};

export function PlayerLoginScreen({ adminHref = '/admin/login' }: PlayerLoginScreenProps) {
  return (
    <main className="auth-route auth-route-player">
      <section className="auth-hero">
        <p className="auth-eyebrow">综合靶场竞赛入口</p>
        <h1>选手登录</h1>
        <p className="auth-description">
          面向参赛队伍的统一登录入口。第一阶段先提供正式登录页与后台区分入口，后续再扩展选手中心、比赛大厅和队伍空间。
        </p>
      </section>

      <section className="auth-card">
        <div className="auth-card-header">
          <h2>进入比赛空间</h2>
          <p>请输入比赛分发的账号信息。</p>
        </div>

        <form className="auth-form">
          <label>
            <span>账号</span>
            <input name="account" type="text" placeholder="请输入账号" />
          </label>

          <label>
            <span>密码</span>
            <input name="password" type="password" placeholder="请输入密码" />
          </label>

          <button type="submit">登录选手入口</button>
        </form>

        <p className="auth-helper">
          如果你是平台管理员，请前往
          <Link href={adminHref}>管理员入口</Link>
          。
        </p>
      </section>
    </main>
  );
}
```

```tsx
// apps/web/app/login/page.tsx
import { PlayerLoginScreen } from '../../components/auth/player-login-screen';

export default function LoginPage() {
  return <PlayerLoginScreen />;
}
```

```css
/* apps/web/app/globals.css */
:root {
  color-scheme: light;
  --bg-canvas: #eff4fb;
  --bg-panel: rgba(255, 255, 255, 0.92);
  --bg-shell: #0d1f3a;
  --text-strong: #0f2038;
  --text-muted: #5a6a82;
  --line-soft: rgba(24, 44, 74, 0.1);
  --brand-primary: #1f5fbf;
  --brand-primary-strong: #184b97;
  --success: #13795b;
  --warning: #b36a10;
  --danger: #bf3f45;
  --shadow-panel: 0 24px 60px rgba(16, 35, 63, 0.12);
  --radius-xl: 28px;
  --radius-lg: 20px;
}

html,
body {
  margin: 0;
  min-height: 100%;
  font-family: "IBM Plex Sans", "PingFang SC", "Helvetica Neue", sans-serif;
  background:
    radial-gradient(circle at top left, rgba(71, 117, 196, 0.15), transparent 28%),
    linear-gradient(180deg, #f6f9fe 0%, #edf3fb 100%);
  color: var(--text-strong);
}

* {
  box-sizing: border-box;
}

a {
  color: inherit;
  text-decoration: none;
}

.auth-route {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 24px;
  align-items: stretch;
  padding: 32px;
}

.auth-hero,
.auth-card {
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-panel);
}

.auth-hero {
  padding: 40px;
  background: linear-gradient(145deg, #0e2140 0%, #173867 100%);
  color: #ecf4ff;
}

.auth-card {
  padding: 32px;
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
}

.auth-eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(236, 244, 255, 0.72);
}

.auth-hero h1,
.auth-card h2 {
  margin: 0;
}

.auth-description,
.auth-card-header p,
.auth-helper {
  color: var(--text-muted);
  line-height: 1.7;
}

.auth-hero .auth-description {
  color: rgba(236, 244, 255, 0.78);
}

.auth-form {
  display: grid;
  gap: 14px;
  margin-top: 24px;
}

.auth-form label {
  display: grid;
  gap: 8px;
  font-size: 14px;
  color: var(--text-strong);
}

.auth-form input,
.auth-form button {
  font: inherit;
}

.auth-form input {
  width: 100%;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  padding: 14px 16px;
  background: #f8fbff;
  color: var(--text-strong);
}

.auth-form button {
  border: 0;
  border-radius: 999px;
  padding: 14px 18px;
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-primary-strong));
  color: #ffffff;
  cursor: pointer;
}

.auth-helper a {
  margin: 0 4px;
  color: var(--brand-primary);
  font-weight: 600;
}

@media (max-width: 960px) {
  .auth-route {
    grid-template-columns: 1fr;
    padding: 20px;
  }
}
```

- [ ] **Step 4: 重新运行测试，确认入口页通过**

Run: `pnpm --filter @aliyun-cyber-range/web test -- app/page.test.tsx app/login/page.test.tsx`

Expected: `PASS`，两个测试均通过。

- [ ] **Step 5: 提交这一批入口改动**

```bash
git add apps/web/app/page.tsx apps/web/app/page.test.tsx apps/web/app/login/page.tsx apps/web/app/login/page.test.tsx apps/web/components/auth/player-login-screen.tsx apps/web/app/globals.css
git commit -m "feat: add root redirect and player login entry"
```

---

### Task 2: 管理员登录页与后台登录态恢复

**Files:**
- Create: `apps/web/app/admin/login/page.tsx`
- Create: `apps/web/app/admin/login/page.test.tsx`
- Create: `apps/web/components/auth/admin-login-screen.tsx`
- Create: `apps/web/lib/admin-auth-storage.ts`
- Create: `apps/web/components/admin/use-admin-session.ts`

- [ ] **Step 1: 先写管理员登录失败测试**

```tsx
// apps/web/app/admin/login/page.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const fetchMock = vi.fn();
const storage = new Map<string, string>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace,
  }),
}));

vi.stubGlobal('fetch', fetchMock);

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
});

import AdminLoginPage from './page';

describe('AdminLoginPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    replace.mockReset();
    storage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores the admin token and redirects to /admin after a successful login', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'dev-admin-token',
          profile: { username: 'admin' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<AdminLoginPage />);

    expect(screen.queryByDisplayValue('change-me')).toBeNull();

    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'change-me' } });
    fireEvent.click(screen.getByRole('button', { name: '登录管理后台' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('aliyun-cyber-range-admin-token')).toBe('dev-admin-token');
      expect(replace).toHaveBeenCalledWith('/admin');
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认管理员登录页目前还不存在**

Run: `pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx`

Expected: `FAIL`，报错会集中在 `./page` 和登录行为尚未实现。

- [ ] **Step 3: 实现管理员登录页面、token 存储工具和会话 hook**

```ts
// apps/web/lib/admin-auth-storage.ts
export const ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';

export function readAdminToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function writeAdminToken(token: string) {
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

export function clearAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}
```

```ts
// apps/web/components/admin/use-admin-session.ts
'use client';

import { useEffect, useState } from 'react';

import { clearAdminToken, readAdminToken, writeAdminToken } from '../../lib/admin-auth-storage';

export function useAdminSession() {
  const [token, setToken] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setToken(readAdminToken());
    setIsReady(true);
  }, []);

  return {
    token,
    isReady,
    login(nextToken: string) {
      writeAdminToken(nextToken);
      setToken(nextToken);
    },
    logout() {
      clearAdminToken();
      setToken(null);
    },
  };
}
```

```tsx
// apps/web/components/auth/admin-login-screen.tsx
'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { writeAdminToken } from '../../lib/admin-auth-storage';

type AdminLoginScreenProps = {
  apiBaseUrl?: string;
};

export function AdminLoginScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: AdminLoginScreenProps) {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setErrorMessage('管理员登录失败，请检查账号或密码。');
        return;
      }

      const payload = (await response.json()) as {
        token: string;
      };

      writeAdminToken(payload.token);
      router.replace('/admin');
    } catch {
      setErrorMessage('管理员登录失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-route auth-route-admin">
      <section className="auth-hero">
        <p className="auth-eyebrow">靶场编排与运维控制台</p>
        <h1>管理员登录</h1>
        <p className="auth-description">
          进入后台后，你将看到靶场总览、靶场实例、编排任务和基础配置，重点关注实例状态、公网入口和失败排障。
        </p>
      </section>

      <section className="auth-card">
        <div className="auth-card-header">
          <h2>登录管理后台</h2>
          <p>请使用平台管理员账号登录。</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>管理员账号</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>

          <label>
            <span>登录密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入管理员密码"
            />
          </label>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? '正在登录...' : '登录管理后台'}
          </button>
        </form>

        <p className="auth-helper">
          如果你是参赛队伍，请返回
          <Link href="/login">选手入口</Link>
          。
        </p>
      </section>
    </main>
  );
}
```

```tsx
// apps/web/app/admin/login/page.tsx
import { AdminLoginScreen } from '../../../components/auth/admin-login-screen';

export default function AdminLoginPage() {
  return <AdminLoginScreen />;
}
```

- [ ] **Step 4: 重新运行管理员登录页测试**

Run: `pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx`

Expected: `PASS`，测试能验证 token 被写入并跳转到 `/admin`。

- [ ] **Step 5: 提交管理员登录与会话基础能力**

```bash
git add apps/web/app/admin/login/page.tsx apps/web/app/admin/login/page.test.tsx apps/web/components/auth/admin-login-screen.tsx apps/web/lib/admin-auth-storage.ts apps/web/components/admin/use-admin-session.ts
git commit -m "feat: add admin login flow and session storage"
```

---

### Task 3: 后台共享框架与靶场总览页

**Files:**
- Create: `apps/web/lib/admin-types.ts`
- Create: `apps/web/lib/admin-api.ts`
- Create: `apps/web/components/admin/admin-workspace-shell.tsx`
- Create: `apps/web/components/admin/overview-screen.tsx`
- Create: `apps/web/components/admin/overview-screen.test.tsx`
- Create: `apps/web/app/admin/layout.tsx`
- Modify: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: 先写总览页失败测试**

```tsx
// apps/web/components/admin/overview-screen.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [
      { id: 'range-1', teamId: 'team-1', status: 'running', errorSummary: null, lastJobId: 'job-1' },
      { id: 'range-2', teamId: 'team-1', status: 'create_failed', errorSummary: 'EIP failed', lastJobId: 'job-2' },
    ],
    provisionJobs: [
      { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin' },
      { id: 'job-2', rangeInstanceId: 'range-2', jobType: 'create', status: 'running', triggeredBy: 'admin' },
    ],
  }),
}));

import { OverviewScreen } from './overview-screen';

describe('OverviewScreen', () => {
  it('renders Chinese KPI cards and recent activity sections', async () => {
    render(<OverviewScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场总览');
    expect(screen.getByText('运行中靶场')).toBeTruthy();
    expect(screen.getByText('创建中任务')).toBeTruthy();
    expect(screen.getByText('失败实例')).toBeTruthy();
    expect(screen.getByText('最近任务')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试，确认总览页组件尚不存在**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/overview-screen.test.tsx`

Expected: `FAIL`，报错会集中在 `overview-screen.tsx` 与 `admin-api.ts` 缺失。

- [ ] **Step 3: 实现共享类型、API 封装、后台外壳和总览页**

```ts
// apps/web/lib/admin-types.ts
export type Competition = {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
};

export type Team = {
  id: string;
  competitionId: string;
  name: string;
  contactName?: string | null;
  contactEmailOrPhone?: string | null;
};

export type RangeTemplate = {
  id: string;
  name?: string | null;
  slug: string;
  version: string;
  modulePathOrRef?: string | null;
};

export type RangeAccessEntry = {
  hostRole?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  ssh?: string | null;
  url?: string | null;
};

export type RangeResourceSummary = {
  mode?: string | null;
  vpcId?: string | null;
  topologySpec?: {
    vpcCidr?: string | null;
  } | null;
};

export type RangeInstance = {
  id: string;
  status: string;
  teamId: string;
  lastJobId?: string | null;
  errorSummary?: string | null;
  expiresAt?: string | null;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
};

export type RangeInstanceDetail = RangeInstance & {
  competitionId: string;
  templateId: string;
};

export type ProvisionJob = {
  id: string;
  rangeInstanceId: string;
  jobType: string;
  status: string;
  triggeredBy: string;
  errorSummary?: string | null;
};

export type ProvisionJobStep = {
  id: string;
  jobId: string;
  stepName: string;
  status: string;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
};

export type CloudConfigSnapshot = {
  region: string;
  zoneId: string;
  provisionerMode: string;
  instanceTypeStrategy: string;
  instanceTypePreferences: string[];
};

export type AdminBootstrapData = {
  competitions: Competition[];
  teams: Team[];
  rangeTemplates: RangeTemplate[];
  rangeInstances: RangeInstance[];
  provisionJobs: ProvisionJob[];
};
```

```ts
// apps/web/lib/admin-api.ts
import type {
  AdminBootstrapData,
  CloudConfigSnapshot,
  Competition,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstance,
  RangeInstanceDetail,
  RangeTemplate,
  Team,
} from './admin-types';

function createAdminHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function fetchAdminBootstrap(apiBaseUrl: string, token: string): Promise<AdminBootstrapData> {
  const headers = createAdminHeaders(token);
  const [competitionsResponse, teamsResponse, templatesResponse, instancesResponse, jobsResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/admin/competitions`, { headers }),
    fetch(`${apiBaseUrl}/admin/teams`, { headers }),
    fetch(`${apiBaseUrl}/admin/range-templates`, { headers }),
    fetch(`${apiBaseUrl}/admin/range-instances`, { headers }),
    fetch(`${apiBaseUrl}/admin/provision-jobs`, { headers }),
  ]);

  return {
    competitions: await readJson<Competition[]>(competitionsResponse),
    teams: await readJson<Team[]>(teamsResponse),
    rangeTemplates: await readJson<RangeTemplate[]>(templatesResponse),
    rangeInstances: await readJson<RangeInstance[]>(instancesResponse),
    provisionJobs: await readJson<ProvisionJob[]>(jobsResponse),
  };
}

export async function fetchRangeInstanceDetail(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances/${id}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function fetchProvisionJobDetail(apiBaseUrl: string, token: string, id: string) {
  const headers = createAdminHeaders(token);
  const [jobResponse, stepsResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/admin/provision-jobs/${id}`, { headers }),
    fetch(`${apiBaseUrl}/admin/provision-jobs/${id}/steps`, { headers }),
  ]);

  return {
    job: await readJson<ProvisionJob>(jobResponse),
    steps: await readJson<ProvisionJobStep[]>(stepsResponse),
  };
}

export async function triggerRangeAction(apiBaseUrl: string, token: string, id: string, action: 'create' | 'destroy', triggeredBy: string) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances/${id}/${action}`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<ProvisionJob>(response);
}

export async function fetchCloudConfig(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/system-config`, {
    headers: createAdminHeaders(token),
  });

  return readJson<CloudConfigSnapshot>(response);
}
```

```tsx
// apps/web/components/admin/admin-workspace-shell.tsx
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect } from 'react';

import { useAdminSession } from './use-admin-session';

type AdminWorkspaceShellProps = {
  children: ReactNode;
};

const navigationItems = [
  { href: '/admin', label: '靶场总览' },
  { href: '/admin/range-instances', label: '靶场实例' },
  { href: '/admin/provision-jobs', label: '编排任务' },
  { href: '/admin/settings', label: '基础配置' },
];

export function AdminWorkspaceShell({ children }: AdminWorkspaceShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAdminSession();

  useEffect(() => {
    if (session.isReady && !session.token) {
      router.replace('/admin/login');
    }
  }, [router, session.isReady, session.token]);

  if (!session.isReady) {
    return <main className="admin-loading">正在恢复后台会话...</main>;
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <p>综合靶场平台</p>
          <strong>管理后台</strong>
        </div>

        <nav className="admin-nav">
          {navigationItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? 'admin-nav-link active' : 'admin-nav-link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="admin-main-shell">
        <header className="admin-topbar">
          <div>
            <p className="admin-topbar-eyebrow">靶场编排与运维控制台</p>
            <strong>当前环境：本地开发</strong>
          </div>

          <button
            type="button"
            onClick={() => {
              session.logout();
              router.replace('/admin/login');
            }}
          >
            退出登录
          </button>
        </header>

        <section className="admin-main-content">{children}</section>
      </div>
    </div>
  );
}
```

```tsx
// apps/web/components/admin/overview-screen.tsx
'use client';

import { useEffect, useState } from 'react';

import { fetchAdminBootstrap } from '../../lib/admin-api';
import type { AdminBootstrapData } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type OverviewScreenProps = {
  apiBaseUrl?: string;
};

export function OverviewScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: OverviewScreenProps) {
  const { token } = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      return;
    }

    fetchAdminBootstrap(apiBaseUrl, token)
      .then((payload) => setSnapshot(payload))
      .catch(() => setErrorMessage('靶场总览加载失败，请刷新页面后重试。'));
  }, [apiBaseUrl, token]);

  const runningCount = snapshot?.rangeInstances.filter((item) => item.status === 'running').length ?? 0;
  const runningJobsCount = snapshot?.provisionJobs.filter((item) => item.status === 'running').length ?? 0;
  const failedCount =
    snapshot?.rangeInstances.filter((item) => item.status.includes('failed') || item.errorSummary).length ?? 0;

  return (
    <div className="admin-screen">
      <section className="admin-screen-hero">
        <p className="admin-screen-eyebrow">后台首页</p>
        <h1>靶场总览</h1>
        <p>登录后的第一屏优先展示实例状态、任务状态、公网入口与失败排障信息。</p>
      </section>

      {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

      <section className="admin-kpi-grid">
        <article className="admin-kpi-card">
          <span>运行中靶场</span>
          <strong>{runningCount}</strong>
        </article>
        <article className="admin-kpi-card">
          <span>创建中任务</span>
          <strong>{runningJobsCount}</strong>
        </article>
        <article className="admin-kpi-card">
          <span>失败实例</span>
          <strong>{failedCount}</strong>
        </article>
        <article className="admin-kpi-card">
          <span>模板数量</span>
          <strong>{snapshot?.rangeTemplates.length ?? 0}</strong>
        </article>
      </section>

      <section className="admin-two-column">
        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>最近任务</h2>
          </div>
          <ul className="admin-list">
            {(snapshot?.provisionJobs ?? []).slice(0, 5).map((job) => (
              <li key={job.id}>
                <div className="admin-list-copy">
                  <strong>{job.jobType === 'create' ? '创建任务' : '销毁任务'}</strong>
                  <span>状态：{job.status}</span>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>异常实例</h2>
          </div>
          <ul className="admin-list">
            {(snapshot?.rangeInstances ?? [])
              .filter((item) => item.status.includes('failed') || item.errorSummary)
              .slice(0, 5)
              .map((instance) => (
                <li key={instance.id}>
                  <div className="admin-list-copy">
                    <strong>{instance.id}</strong>
                    <span>{instance.errorSummary ?? `状态：${instance.status}`}</span>
                  </div>
                </li>
              ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
```

```tsx
// apps/web/app/admin/layout.tsx
import { ReactNode } from 'react';

import { AdminWorkspaceShell } from '../../components/admin/admin-workspace-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminWorkspaceShell>{children}</AdminWorkspaceShell>;
}
```

```tsx
// apps/web/app/admin/page.tsx
import { OverviewScreen } from '../../components/admin/overview-screen';

export default function AdminPage() {
  return <OverviewScreen />;
}
```

- [ ] **Step 4: 运行总览页测试**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/overview-screen.test.tsx`

Expected: `PASS`，能看到中文 KPI 和“最近任务”区块。

- [ ] **Step 5: 提交后台外壳和总览页**

```bash
git add apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/admin-workspace-shell.tsx apps/web/components/admin/overview-screen.tsx apps/web/components/admin/overview-screen.test.tsx apps/web/app/admin/layout.tsx apps/web/app/admin/page.tsx
git commit -m "feat: add admin workspace shell and overview screen"
```

---

### Task 4: 靶场实例页与编排任务页

**Files:**
- Create: `apps/web/app/admin/range-instances/page.tsx`
- Create: `apps/web/app/admin/provision-jobs/page.tsx`
- Create: `apps/web/components/admin/range-instances-screen.tsx`
- Create: `apps/web/components/admin/provision-jobs-screen.tsx`
- Create: `apps/web/components/admin/range-instances-screen.test.tsx`
- Create: `apps/web/components/admin/provision-jobs-screen.test.tsx`

- [ ] **Step 1: 先写实例页和任务页失败测试**

```tsx
// apps/web/components/admin/range-instances-screen.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [
      { id: 'range-1', teamId: 'team-1', status: 'running', lastJobId: 'job-1', errorSummary: null },
      { id: 'range-2', teamId: 'team-1', status: 'create_failed', lastJobId: 'job-2', errorSummary: '规格不可售' },
    ],
    provisionJobs: [],
  }),
  fetchRangeInstanceDetail: vi.fn().mockResolvedValue({
    id: 'range-1',
    status: 'running',
    teamId: 'team-1',
    competitionId: 'competition-1',
    templateId: 'template-1',
    accessEntry: { publicIp: '47.1.1.1', ssh: 'ssh root@47.1.1.1' },
    resourceSummary: { vpcId: 'vpc-123' },
  }),
  triggerRangeAction: vi.fn().mockResolvedValue({
    id: 'job-3',
    rangeInstanceId: 'range-1',
    jobType: 'destroy',
    status: 'pending',
    triggeredBy: 'admin',
  }),
}));

import { RangeInstancesScreen } from './range-instances-screen';

describe('RangeInstancesScreen', () => {
  it('filters instances and shows the selected instance detail', async () => {
    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));

    await screen.findByText('公网入口');
    expect(screen.getByText('47.1.1.1')).toBeTruthy();
  });
});
```

```tsx
// apps/web/components/admin/provision-jobs-screen.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [],
    teams: [],
    rangeTemplates: [],
    rangeInstances: [],
    provisionJobs: [{ id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' }],
  }),
  fetchProvisionJobDetail: vi.fn().mockResolvedValue({
    job: { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' },
    steps: [{ id: 'step-1', jobId: 'job-1', stepName: 'validate', status: 'succeeded', message: '校验通过' }],
  }),
}));

import { ProvisionJobsScreen } from './provision-jobs-screen';

describe('ProvisionJobsScreen', () => {
  it('loads job steps when the operator opens a job detail', async () => {
    render(<ProvisionJobsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排任务');
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-1' }));

    await screen.findByText('步骤日志');
    expect(screen.getByText('校验通过')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试，确认实例页和任务页尚未实现**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`

Expected: `FAIL`，两个页面组件文件都还不存在。

- [ ] **Step 3: 实现实例页与任务页**

```tsx
// apps/web/components/admin/range-instances-screen.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';

import { fetchAdminBootstrap, fetchRangeInstanceDetail, triggerRangeAction } from '../../lib/admin-api';
import type { AdminBootstrapData, RangeInstanceDetail } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

export function RangeInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: {
  apiBaseUrl?: string;
}) {
  const { token } = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selected, setSelected] = useState<RangeInstanceDetail | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (!token) {
      return;
    }

    fetchAdminBootstrap(apiBaseUrl, token).then(setSnapshot);
  }, [apiBaseUrl, token]);

  const visibleInstances = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    if (statusFilter === 'all') {
      return snapshot.rangeInstances;
    }

    return snapshot.rangeInstances.filter((item) => item.status === statusFilter);
  }, [snapshot, statusFilter]);

  return (
    <div className="admin-screen">
      <section className="admin-screen-hero">
        <p className="admin-screen-eyebrow">后台二级页</p>
        <h1>靶场实例</h1>
        <p>查看每个队伍的实例状态、公网入口、最近任务和失败摘要。</p>
      </section>

      <section className="admin-panel">
        <label className="admin-filter">
          <span>实例状态</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="draft">草稿</option>
            <option value="running">运行中</option>
            <option value="create_failed">创建失败</option>
            <option value="destroyed">已销毁</option>
          </select>
        </label>
      </section>

      <section className="admin-two-column">
        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>实例列表</h2>
          </div>
          <ul className="admin-list">
            {visibleInstances.map((instance) => (
              <li key={instance.id}>
                <div className="admin-list-copy">
                  <strong>{instance.id}</strong>
                  <span>状态：{instance.status}</span>
                </div>
                <div className="admin-list-actions">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!token) {
                        return;
                      }

                      setSelected(await fetchRangeInstanceDetail(apiBaseUrl, token, instance.id));
                    }}
                  >
                    查看实例 {instance.id}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>实例详情</h2>
          </div>
          {selected ? (
            <div className="admin-detail-stack">
              <div className="admin-metadata">
                <h3>公网入口</h3>
                <p>{selected.accessEntry?.publicIp ?? '暂无公网入口'}</p>
                <p>{selected.accessEntry?.ssh ?? '暂无 SSH 信息'}</p>
              </div>
              <div className="admin-metadata">
                <h3>资源摘要</h3>
                <p>{selected.resourceSummary?.vpcId ?? '暂无 VPC 摘要'}</p>
              </div>
              <div className="admin-inline-actions">
                <button
                  type="button"
                  onClick={async () => {
                    if (!token) {
                      return;
                    }

                    await triggerRangeAction(apiBaseUrl, token, selected.id, 'create', 'admin');
                  }}
                >
                  发起创建
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!token) {
                      return;
                    }

                    await triggerRangeAction(apiBaseUrl, token, selected.id, 'destroy', 'admin');
                  }}
                >
                  发起销毁
                </button>
              </div>
            </div>
          ) : (
            <p>请选择一个实例查看详情。</p>
          )}
        </article>
      </section>
    </div>
  );
}
```

```tsx
// apps/web/components/admin/provision-jobs-screen.tsx
'use client';

import { useEffect, useState } from 'react';

import { fetchAdminBootstrap, fetchProvisionJobDetail } from '../../lib/admin-api';
import type { AdminBootstrapData } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

export function ProvisionJobsScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: {
  apiBaseUrl?: string;
}) {
  const { token } = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<string[]>([]);

  useEffect(() => {
    if (!token) {
      return;
    }

    fetchAdminBootstrap(apiBaseUrl, token).then(setSnapshot);
  }, [apiBaseUrl, token]);

  return (
    <div className="admin-screen">
      <section className="admin-screen-hero">
        <p className="admin-screen-eyebrow">后台二级页</p>
        <h1>编排任务</h1>
        <p>集中查看创建、销毁与重试任务，定位失败步骤和任务上下文。</p>
      </section>

      <section className="admin-two-column">
        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>任务列表</h2>
          </div>
          <ul className="admin-list">
            {(snapshot?.provisionJobs ?? []).map((job) => (
              <li key={job.id}>
                <div className="admin-list-copy">
                  <strong>{job.id}</strong>
                  <span>{job.jobType} / {job.status}</span>
                </div>
                <div className="admin-list-actions">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!token) {
                        return;
                      }

                      const detail = await fetchProvisionJobDetail(apiBaseUrl, token, job.id);
                      setSelectedSteps(detail.steps.map((step) => `${step.stepName}: ${step.message ?? step.status}`));
                    }}
                  >
                    查看任务 {job.id}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="admin-panel">
          <div className="admin-panel-header">
            <h2>步骤日志</h2>
          </div>
          <ul className="admin-list">
            {selectedSteps.map((item) => (
              <li key={item}>
                <div className="admin-list-copy">
                  <strong>{item}</strong>
                </div>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
```

```tsx
// apps/web/app/admin/range-instances/page.tsx
import { RangeInstancesScreen } from '../../../components/admin/range-instances-screen';

export default function RangeInstancesPage() {
  return <RangeInstancesScreen />;
}
```

```tsx
// apps/web/app/admin/provision-jobs/page.tsx
import { ProvisionJobsScreen } from '../../../components/admin/provision-jobs-screen';

export default function ProvisionJobsPage() {
  return <ProvisionJobsScreen />;
}
```

- [ ] **Step 4: 重新运行实例页与任务页测试**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`

Expected: `PASS`，两个页面都能显示详情区。

- [ ] **Step 5: 提交实例页与任务页**

```bash
git add apps/web/app/admin/range-instances/page.tsx apps/web/app/admin/provision-jobs/page.tsx apps/web/components/admin/range-instances-screen.tsx apps/web/components/admin/provision-jobs-screen.tsx apps/web/components/admin/range-instances-screen.test.tsx apps/web/components/admin/provision-jobs-screen.test.tsx
git commit -m "feat: add range instance and provision job screens"
```

---

### Task 5: 基础配置页与最小云配置接口

**Files:**
- Create: `apps/api/src/admin/system-config.service.ts`
- Create: `apps/api/src/admin/system-config.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/admin-system-config.e2e-spec.ts`
- Create: `apps/web/app/admin/settings/page.tsx`
- Create: `apps/web/components/admin/settings/settings-screen.tsx`
- Create: `apps/web/components/admin/settings/competitions-panel.tsx`
- Create: `apps/web/components/admin/settings/teams-panel.tsx`
- Create: `apps/web/components/admin/settings/templates-panel.tsx`
- Create: `apps/web/components/admin/settings/cloud-config-panel.tsx`
- Create: `apps/web/components/admin/settings/settings-screen.test.tsx`
- Modify: `apps/web/lib/admin-api.ts`

- [ ] **Step 1: 先写 API 和前端失败测试**

```ts
// apps/api/test/admin-system-config.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/bootstrap/configure-app';
import { AppModule } from '../src/app.module';

describe('Admin system config', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.ALICLOUD_REGION = 'cn-hangzhou';
    process.env.ALICLOUD_ZONE_ID = 'cn-hangzhou-h';
    process.env.RANGE_PROVISIONER_MODE = 'dry-run';
    process.env.OPENTOFU_INSTANCE_TYPE = 'auto';
    process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES = 'ecs.t6-c1m2.large,ecs.c7.large';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the current cloud configuration snapshot', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual({
      region: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      provisionerMode: 'dry-run',
      instanceTypeStrategy: 'auto',
      instanceTypePreferences: ['ecs.t6-c1m2.large', 'ecs.c7.large'],
    });
  });
});
```

```tsx
// apps/web/components/admin/settings/settings-screen.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛', status: 'scheduled' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [],
    provisionJobs: [],
  }),
  fetchCloudConfig: vi.fn().mockResolvedValue({
    region: 'cn-hangzhou',
    zoneId: 'cn-hangzhou-h',
    provisionerMode: 'dry-run',
    instanceTypeStrategy: 'auto',
    instanceTypePreferences: ['ecs.t6-c1m2.large'],
  }),
}));

import { SettingsScreen } from './settings-screen';

describe('SettingsScreen', () => {
  it('renders tabbed settings sections including cloud config', async () => {
    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('基础配置');
    expect(screen.getByRole('tab', { name: '比赛' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '云配置' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试，确认 API 和设置页目前都不存在**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-system-config.e2e-spec.ts`

Expected: `FAIL`，接口还未注册。

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: `FAIL`，设置页组件与路由还不存在。

- [ ] **Step 3: 先实现最小云配置接口**

```ts
// apps/api/src/admin/system-config.service.ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class SystemConfigService {
  getSnapshot() {
    return {
      region: process.env.ALICLOUD_REGION ?? 'unset',
      zoneId: process.env.ALICLOUD_ZONE_ID ?? 'unset',
      provisionerMode: process.env.RANGE_PROVISIONER_MODE ?? 'unset',
      instanceTypeStrategy: process.env.OPENTOFU_INSTANCE_TYPE ?? process.env.ALICLOUD_INSTANCE_TYPE ?? 'unset',
      instanceTypePreferences: (process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES ??
        process.env.ALICLOUD_INSTANCE_TYPE_PREFERENCES ??
        '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
}
```

```ts
// apps/api/src/admin/system-config.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { SystemConfigService } from './system-config.service';

@Controller('admin/system-config')
@UseGuards(AdminAuthGuard)
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get()
  getSnapshot() {
    return this.systemConfigService.getSnapshot();
  }
}
```

```ts
// apps/api/src/app.module.ts
import { SystemConfigController } from './admin/system-config.controller';
import { SystemConfigService } from './admin/system-config.service';

// 在 @Module 元数据中补上：
controllers: [
  // ...existing controllers,
  SystemConfigController,
],
providers: [
  // ...existing providers,
  SystemConfigService,
]
```

- [ ] **Step 4: 运行 API 测试，确认云配置接口通过**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-system-config.e2e-spec.ts`

Expected: `PASS`，返回 region / zone / strategy / preferences。

- [ ] **Step 5: 再实现基础配置页与页内标签**

```tsx
// apps/web/components/admin/settings/cloud-config-panel.tsx
import type { CloudConfigSnapshot } from '../../../lib/admin-types';

export function CloudConfigPanel({ config }: { config: CloudConfigSnapshot | null }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <h2>云配置</h2>
      </div>
      <ul className="admin-list">
        <li><div className="admin-list-copy"><strong>默认地域</strong><span>{config?.region ?? '未配置'}</span></div></li>
        <li><div className="admin-list-copy"><strong>默认可用区</strong><span>{config?.zoneId ?? '未配置'}</span></div></li>
        <li><div className="admin-list-copy"><strong>编排模式</strong><span>{config?.provisionerMode ?? '未配置'}</span></div></li>
        <li><div className="admin-list-copy"><strong>实例规格策略</strong><span>{config?.instanceTypeStrategy ?? '未配置'}</span></div></li>
      </ul>
    </section>
  );
}
```

```tsx
// apps/web/components/admin/settings/competitions-panel.tsx
import type { Competition } from '../../../lib/admin-types';

export function CompetitionsPanel({ competitions }: { competitions: Competition[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <h2>比赛</h2>
      </div>
      <ul className="admin-list">
        {competitions.map((competition) => (
          <li key={competition.id}>
            <div className="admin-list-copy">
              <strong>{competition.name}</strong>
              <span>{competition.status ?? '未设置状态'}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

```tsx
// apps/web/components/admin/settings/teams-panel.tsx
import type { Team } from '../../../lib/admin-types';

export function TeamsPanel({ teams }: { teams: Team[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <h2>队伍</h2>
      </div>
      <ul className="admin-list">
        {teams.map((team) => (
          <li key={team.id}>
            <div className="admin-list-copy">
              <strong>{team.name}</strong>
              <span>{team.contactName ?? '暂无联系人'}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

```tsx
// apps/web/components/admin/settings/templates-panel.tsx
import type { RangeTemplate } from '../../../lib/admin-types';

export function TemplatesPanel({ templates }: { templates: RangeTemplate[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <h2>模板</h2>
      </div>
      <ul className="admin-list">
        {templates.map((template) => (
          <li key={template.id}>
            <div className="admin-list-copy">
              <strong>{template.slug}</strong>
              <span>{template.version}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

```tsx
// apps/web/components/admin/settings/settings-screen.tsx
'use client';

import { useEffect, useState } from 'react';

import { fetchAdminBootstrap, fetchCloudConfig } from '../../../lib/admin-api';
import type { AdminBootstrapData, CloudConfigSnapshot } from '../../../lib/admin-types';
import { useAdminSession } from '../use-admin-session';
import { CloudConfigPanel } from './cloud-config-panel';
import { CompetitionsPanel } from './competitions-panel';
import { TeamsPanel } from './teams-panel';
import { TemplatesPanel } from './templates-panel';

const tabs = ['比赛', '队伍', '模板', '云配置'] as const;

export function SettingsScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: {
  apiBaseUrl?: string;
}) {
  const { token } = useAdminSession();
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('比赛');
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot | null>(null);

  useEffect(() => {
    if (!token) {
      return;
    }

    fetchAdminBootstrap(apiBaseUrl, token).then(setSnapshot);
    fetchCloudConfig(apiBaseUrl, token).then(setCloudConfig);
  }, [apiBaseUrl, token]);

  return (
    <div className="admin-screen">
      <section className="admin-screen-hero">
        <p className="admin-screen-eyebrow">后台二级页</p>
        <h1>基础配置</h1>
        <p>把比赛、队伍、模板与云配置集中到一个页内工作台中管理。</p>
      </section>

      <div className="admin-tab-strip" role="tablist" aria-label="基础配置标签">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={activeTab === tab ? 'admin-tab active' : 'admin-tab'}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === '比赛' ? <CompetitionsPanel competitions={snapshot?.competitions ?? []} /> : null}
      {activeTab === '队伍' ? <TeamsPanel teams={snapshot?.teams ?? []} /> : null}
      {activeTab === '模板' ? <TemplatesPanel templates={snapshot?.rangeTemplates ?? []} /> : null}
      {activeTab === '云配置' ? <CloudConfigPanel config={cloudConfig} /> : null}
    </div>
  );
}
```

```tsx
// apps/web/app/admin/settings/page.tsx
import { SettingsScreen } from '../../../components/admin/settings/settings-screen';

export default function SettingsPage() {
  return <SettingsScreen />;
}
```

- [ ] **Step 6: 运行设置页测试**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: `PASS`，能看到“基础配置”标题和页内标签。

- [ ] **Step 7: 提交基础配置页与系统配置接口**

```bash
git add apps/api/src/admin/system-config.service.ts apps/api/src/admin/system-config.controller.ts apps/api/src/app.module.ts apps/api/test/admin-system-config.e2e-spec.ts apps/web/app/admin/settings/page.tsx apps/web/components/admin/settings/settings-screen.tsx apps/web/components/admin/settings/competitions-panel.tsx apps/web/components/admin/settings/teams-panel.tsx apps/web/components/admin/settings/templates-panel.tsx apps/web/components/admin/settings/cloud-config-panel.tsx apps/web/components/admin/settings/settings-screen.test.tsx apps/web/lib/admin-api.ts
git commit -m "feat: add settings workspace and cloud config endpoint"
```

---

### Task 6: 清理旧单文件后台并做全量回归

**Files:**
- Delete: `apps/web/app/admin/admin-console.tsx`
- Delete: `apps/web/app/admin/admin-console.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 删除旧的单文件后台实现与旧测试**

```bash
rm apps/web/app/admin/admin-console.tsx
rm apps/web/app/admin/admin-console.test.tsx
```

- [ ] **Step 2: 补齐共享样式中后台导航、标签与空状态样式**

```css
/* apps/web/app/globals.css */
.admin-workspace {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 260px 1fr;
  background: linear-gradient(180deg, #eef4fc 0%, #f7fbff 100%);
}

.admin-sidebar {
  padding: 24px;
  background: linear-gradient(180deg, #0d1f3a 0%, #122a4f 100%);
  color: #ecf4ff;
}

.admin-brand p,
.admin-screen-eyebrow,
.admin-topbar-eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.admin-nav {
  display: grid;
  gap: 8px;
  margin-top: 24px;
}

.admin-nav-link,
.admin-tab {
  border-radius: 14px;
  padding: 12px 14px;
  color: inherit;
}

.admin-nav-link.active,
.admin-tab.active {
  background: rgba(110, 173, 255, 0.18);
}

.admin-main-shell {
  display: grid;
  grid-template-rows: auto 1fr;
}

.admin-topbar,
.admin-panel,
.admin-screen-hero,
.admin-kpi-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--line-soft);
  border-radius: 20px;
  box-shadow: var(--shadow-panel);
}

.admin-topbar,
.admin-screen-hero,
.admin-panel,
.admin-kpi-card {
  padding: 24px;
}

.admin-main-content {
  padding: 24px;
}

.admin-screen {
  display: grid;
  gap: 18px;
}

.admin-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.admin-two-column {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 14px;
}

.admin-tab-strip {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.form-error {
  margin: 0;
  color: var(--danger);
}

.admin-loading {
  min-height: 100vh;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

@media (max-width: 1080px) {
  .admin-workspace,
  .admin-kpi-grid,
  .admin-two-column {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: 运行 Web 和 API 的完整测试回归**

Run: `pnpm --filter @aliyun-cyber-range/web test`

Expected: `PASS`

Run: `pnpm --filter @aliyun-cyber-range/api test`

Expected: `PASS`

Run: `pnpm test`

Expected: `PASS`

- [ ] **Step 4: 运行构建，确认新路由没有破坏 monorepo 基线**

Run: `pnpm build`

Expected: `PASS`

- [ ] **Step 5: 做一次本地手工 smoke 验证**

Run: `pnpm dev`

Expected:

- `http://localhost:3000/` 自动跳转到 `/login`
- `http://localhost:3000/admin/login` 可登录后台
- 登录后能进入 `/admin`
- 侧边导航能切到 `靶场实例 / 编排任务 / 基础配置`

- [ ] **Step 6: 提交最后的清理与回归结果**

```bash
git add apps/web/app/globals.css apps/web/app/admin apps/web/components/auth apps/web/components/admin apps/web/lib apps/api/src/admin/system-config.service.ts apps/api/src/admin/system-config.controller.ts apps/api/src/app.module.ts apps/api/test/admin-system-config.e2e-spec.ts
git add -u apps/web/app/admin/admin-console.tsx apps/web/app/admin/admin-console.test.tsx
git commit -m "refactor: replace monolithic admin console with routed workspace"
```

---

## 自检记录

### 1. Spec coverage

- 根路由改成 `/login`：Task 1
- 独立 `/login`：Task 1
- 独立 `/admin/login`：Task 2
- 中文后台与一级导航：Task 3
- `靶场实例 / 编排任务`：Task 4
- `基础配置` 与 `云配置`：Task 5
- 单文件 `AdminConsole` 拆除与全量回归：Task 6

### 2. Placeholder scan

本计划没有使用占位语，所有任务都给出了明确文件、命令和代码骨架。

### 3. Type consistency

- `AdminBootstrapData` 在 Task 3 定义，并在 Task 4/5 复用
- `fetchCloudConfig` 与 `CloudConfigSnapshot` 一一对应
- `useAdminSession` 在 Task 2 引入，Task 3/4/5 统一复用
