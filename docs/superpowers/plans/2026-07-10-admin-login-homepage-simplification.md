# Admin Login Homepage Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将管理员登录页改成极简单栏布局，只保留平台名称、登录标题和表单，删除当前杂乱的说明区与标签区，同时保持登录行为完全不变。

**Architecture:** 直接复用现有 `AdminLoginScreen` 组件与现有登录提交流程，不新增组件层。先扩展现有页面测试去约束“该删的内容已删、该留的行为还在”，再用最小 JSX 和 CSS 改动把登录页收成单栏居中卡片。

**Tech Stack:** Next.js App Router、React、Vitest、Testing Library、全局样式 `apps/web/app/globals.css`

---

### Task 1: 用现有页面测试锁定新版登录页结构

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx`
- Test: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx`

- [ ] **Step 1: 在登录页测试里新增“极简单栏”断言**

```tsx
it('renders the simplified admin login layout', async () => {
  render(await AdminLoginPage());

  expect(screen.getByText('综合靶场平台')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '管理员登录' })).toBeTruthy();
  expect(screen.getByLabelText('管理员登录表单')).toBeTruthy();
  expect(screen.getByText('管理员账号')).toBeTruthy();
  expect(screen.getByText('登录密码')).toBeTruthy();
  expect(screen.getByRole('button', { name: '登录管理后台' })).toBeTruthy();

  expect(screen.queryByText('阿里云企业网络型靶场编排与实例管理工作台')).toBeNull();
  expect(screen.queryByText('统一后台入口')).toBeNull();
  expect(screen.queryByText('靶场编排优先')).toBeNull();
  expect(screen.queryByText('工作台 / 靶场编排')).toBeNull();
  expect(screen.queryByText('角色 / 管理员')).toBeNull();
});
```

- [ ] **Step 2: 运行这个页面测试，确认它先失败**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx
```

Expected:

```text
FAIL ... expected queryByText(...) to be null
```

- [ ] **Step 3: 保留现有错误态和提交态断言，不新增新的行为测试**

```tsx
// 保留现有这些断言，不改登录行为：
expect(screen.getByText('管理员登录失败，请检查账号或密码。')).toBeTruthy();
expect(screen.getByRole('button', { name: '正在登录...' })).toBeDisabled();
expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios');
```

- [ ] **Step 4: 再跑一次测试文件，确认只有结构断言失败**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx
```

Expected:

```text
1 failing test for simplified layout, existing login behavior assertions still reachable
```

- [ ] **Step 5: Commit**

```bash
git add /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx
git commit -m "test: cover simplified admin login layout"
```

### Task 2: 收紧登录页 JSX 和专用样式

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/auth/admin-login-screen.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/globals.css`
- Test: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx`

- [ ] **Step 1: 把登录页 JSX 改成单栏居中卡片**

```tsx
return (
  <main className="admin-login-shell">
    <section className="admin-login-card">
      <div className="admin-login-card-copy">
        <strong>综合靶场平台</strong>
        <h1>管理员登录</h1>
      </div>

      <form aria-label="管理员登录表单" className="admin-form admin-login-form" method="post" onSubmit={handleSubmit}>
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
    </section>
  </main>
);
```

- [ ] **Step 2: 删除旧侧栏/顶栏结构，不保留任何说明块或 badge**

```tsx
// 删除这些块，而不是只用 CSS 隐藏：
<aside className="admin-login-sidebar">...</aside>
<header className="admin-topbar admin-login-topbar">...</header>
<p className="admin-description admin-login-description">...</p>
```

- [ ] **Step 3: 在全局样式里新增极简登录页专用类，并停止依赖旧登录页布局类**

```css
.admin-login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 16px;
  background:
    radial-gradient(circle at top, rgba(44, 99, 187, 0.08), transparent 32%),
    linear-gradient(180deg, #f7f9fc 0%, #f2f5fa 100%);
}

.admin-login-card {
  width: min(420px, 100%);
  display: grid;
  gap: 22px;
  padding: 28px;
  border: 1px solid #e5ebf2;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 16px 40px rgba(29, 43, 68, 0.08);
}

.admin-login-card-copy {
  display: grid;
  gap: 6px;
  text-align: center;
}

.admin-login-card-copy strong {
  font-size: 14px;
  color: #22314d;
}

.admin-login-card-copy h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.1;
  color: #16233a;
}

.admin-login-form {
  display: grid;
  gap: 16px;
}
```

- [ ] **Step 4: 删除仅供旧登录页使用的专用样式**

```css
/* 删除或清空这些旧登录页专用类的依赖 */
.admin-login-sidebar
.admin-login-note
.admin-login-main-shell
.admin-login-topbar
.admin-login-content
.admin-login-form-panel
.admin-login-header
.admin-login-description
```

- [ ] **Step 5: 运行页面测试，确认新版结构和原行为同时通过**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx
```

Expected:

```text
PASS ... app/admin/login/page.test.tsx
```

- [ ] **Step 6: 运行前端构建，确认没有样式或 JSX 回归**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web build
```

Expected:

```text
Compiled successfully
```

- [ ] **Step 7: Commit**

```bash
git add /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/auth/admin-login-screen.tsx /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/globals.css /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx
git commit -m "feat: simplify admin login homepage"
```
