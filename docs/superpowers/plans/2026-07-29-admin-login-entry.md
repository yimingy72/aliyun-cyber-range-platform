# Admin Login Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone administrator login card with the approved workbench-aligned login entry while preserving the OIDC authentication flow.

**Architecture:** Keep `AdminLoginScreen` as the sole owner of login behavior and change only its rendered structure. Use the existing canonical platform mark, shared `Button`, Lucide icons, and global workbench CSS primitives; add focused CSS classes for desktop and mobile layout without changing session, OIDC, callback, or route code.

**Tech Stack:** Next.js 15 client component, React, TypeScript, Tailwind-backed shared `Button`, Lucide React, Vitest, Testing Library, Docker Compose.

---

## File Structure

- Modify: `apps/web/components/auth/admin-login-screen.tsx`
  - Render the approved accessible login hierarchy, canonical title mark, command-style OIDC button, and security hint.
  - Retain `handleLogin`, `isSubmitting`, `errorMessage`, PKCE storage, and `window.location.assign` unchanged.
- Modify: `apps/web/app/admin/login/page.test.tsx`
  - Lock the login page's canonical title mark and accessible workbench-entry copy while retaining current OIDC behavior tests.
- Modify: `apps/web/app/globals.css`
  - Replace the legacy centered, 24px-radius login-card rules with the approved desktop context column, 6px workbench surface, compact action rhythm, and mobile collapse.
- Modify: `apps/web/app/globals.css.test.ts`
  - Assert the login-entry layout contract and mobile behavior without relying on browser layout measurements.

### Task 1: Specify The Login Entry Semantics

**Files:**
- Modify: `apps/web/app/admin/login/page.test.tsx:89-105`

- [ ] **Step 1: Write the failing semantic-login test**

  Add this test after `renders a single admin-only login experience without player entry copy`:

  ```tsx
  it('renders the workbench-aligned entry title with the canonical platform mark', () => {
    render(<AdminLoginPage />);

    const title = screen.getByRole('heading', { name: '登录综合靶场平台' });
    const mark = screen.getByTestId('admin-login-title-mark');

    expect(title).toBeTruthy();
    expect(mark.getAttribute('src')).toBe('/brand/platform-mark.svg');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('管理入口')).toBeTruthy();
    expect(screen.getByText('使用平台统一账号验证身份并进入管理后台。')).toBeTruthy();
    expect(screen.getByText('登录由平台统一身份认证服务保护')).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用平台账号登录' })).toBeTruthy();
    expect(screen.queryByText('使用平台统一账号登录管理后台。')).toBeNull();
  });
  ```

- [ ] **Step 2: Build the current web image and run the test to verify it fails**

  Run:

  ```bash
  docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx --pool=forks --maxWorkers=1'
  ```

  Expected: FAIL because the current screen has no `登录综合靶场平台` heading or `admin-login-title-mark`.

- [ ] **Step 3: Replace the login screen structure while preserving authentication behavior**

  In `apps/web/components/auth/admin-login-screen.tsx`, add these imports:

  ```tsx
  import { ArrowRight, LogIn, ShieldCheck } from 'lucide-react';
  import { useState } from 'react';

  import { Button } from '../ui/button';
  import { buildAdminOidcAuthorizeUrl, writePendingAdminOidcLogin } from '../../lib/admin-oidc';
  ```

  Keep `handleLogin` unchanged. Replace only the current `return` value with:

  ```tsx
  return (
    <main className="admin-login-shell">
      <div className="admin-login-layout">
        <aside aria-hidden="true" className="admin-login-context">
          <strong>CYBER RANGE / ADMIN</strong>
          <p>统一身份验证完成后，继续进入综合靶场管理工作台。</p>
        </aside>

        <section aria-labelledby="admin-login-title" className="admin-login-card">
          <div aria-label="管理员登录表单" className="admin-login-form">
            <div className="admin-login-copy">
              <span className="admin-login-eyebrow">管理入口</span>
              <h1 className="admin-login-title" id="admin-login-title">
                <img
                  alt=""
                  aria-hidden="true"
                  data-testid="admin-login-title-mark"
                  height="31"
                  src="/brand/platform-mark.svg"
                  width="31"
                />
                登录综合靶场平台
              </h1>
              <p>使用平台统一账号验证身份并进入管理后台。</p>
            </div>

            {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

            <Button
              className="admin-login-command"
              disabled={isSubmitting}
              onClick={() => void handleLogin()}
              size="lg"
              type="button"
            >
              <span>
                <LogIn aria-hidden="true" data-icon="inline-start" />
                {isSubmitting ? '正在跳转...' : '使用平台账号登录'}
              </span>
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>

            <p className="admin-login-security">
              <ShieldCheck aria-hidden="true" />
              登录由平台统一身份认证服务保护
            </p>
          </div>
        </section>
      </div>
    </main>
  );
  ```

  Do not add a top bar, duplicate logo, divider, route redirect, or any new authentication state.

- [ ] **Step 4: Rebuild and run the focused login test to verify it passes**

  Run:

  ```bash
  docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx --pool=forks --maxWorkers=1'
  ```

  Expected: PASS with all existing PKCE, session, and new semantic-login assertions green.

- [ ] **Step 5: Commit the semantic structure**

  ```bash
  git add apps/web/components/auth/admin-login-screen.tsx apps/web/app/admin/login/page.test.tsx
  git commit -m "feat(web): redesign admin login entry structure"
  ```

### Task 2: Apply The Approved Workbench Layout And Spacing

**Files:**
- Modify: `apps/web/app/globals.css:1138-1187`
- Modify: `apps/web/app/globals.css.test.ts:55-76`

- [ ] **Step 1: Write the failing CSS contract test**

  Add this test inside `describe('design system CSS transition contract', ...)`:

  ```tsx
  it('defines the compact workbench-aligned admin login entry', () => {
    const loginShell = getRuleBlock(stylesheet, '.admin-login-shell');
    const loginLayout = getRuleBlock(stylesheet, '.admin-login-layout');
    const loginCard = getRuleBlock(stylesheet, '.admin-login-card');
    const loginForm = getRuleBlock(stylesheet, '.admin-login-form');
    const loginCommand = getRuleBlock(stylesheet, '.admin-login-command');
    const narrowScreenRules = getAtRuleBlock(stylesheet, '@media (max-width: 720px)');

    expect(loginShell).toContain('background: #f5f7fb');
    expect(loginLayout).toContain('grid-template-columns: minmax(0, 1fr) minmax(360px, 480px)');
    expect(loginCard).toContain('border-radius: 6px');
    expect(loginCard).toContain('padding: 34px');
    expect(loginCard).toContain('animation: admin-content-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both');
    expect(loginForm).toContain('gap: 17px');
    expect(loginCommand).toContain('justify-content: space-between');
    expect(loginCommand).not.toContain('text-align: center');
    expect(getRuleBlock(narrowScreenRules, '.admin-login-context')).toContain('display: none');
  });
  ```

- [ ] **Step 2: Build the current web image and run the CSS test to verify it fails**

  Run:

  ```bash
  docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/globals.css.test.ts --pool=forks --maxWorkers=1'
  ```

  Expected: FAIL because `.admin-login-layout`, `.admin-login-context`, and `.admin-login-command` do not exist and the current card uses a 24px radius.

- [ ] **Step 3: Replace the legacy login CSS with the approved layout**

  Replace the existing `.admin-login-shell` through `.admin-login-form button` rules in `apps/web/app/globals.css` with:

  ```css
  .admin-login-shell {
    min-height: 100dvh;
    display: grid;
    padding: 24px;
    background: #f5f7fb;
  }

  .admin-login-layout {
    width: min(1140px, 100%);
    min-height: 570px;
    margin: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 480px);
    align-items: center;
    gap: 48px;
  }

  .admin-login-context {
    align-self: stretch;
    display: grid;
    align-content: end;
    gap: 12px;
    padding-bottom: 34px;
    color: #8492a6;
  }

  .admin-login-context::before {
    width: min(340px, 76%);
    height: 1px;
    background: #dce5f0;
    content: "";
  }

  .admin-login-context strong {
    color: #5c6e88;
    font-size: 12px;
    letter-spacing: 0.08em;
  }

  .admin-login-context p {
    max-width: 310px;
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
  }

  .admin-login-card {
    width: 100%;
    padding: 34px;
    border: 1px solid #dbe5f0;
    border-radius: 6px;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(24, 44, 74, 0.06);
    animation: admin-content-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .admin-login-form {
    display: grid;
    gap: 17px;
  }

  .admin-login-copy {
    display: grid;
    gap: 9px;
    text-align: left;
  }

  .admin-login-eyebrow {
    color: #4d76aa;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.1em;
  }

  .admin-login-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    color: #22314d;
    font-size: 24px;
    line-height: 1.25;
  }

  .admin-login-title img {
    width: 31px;
    height: 31px;
    flex: 0 0 auto;
  }

  .admin-login-copy p,
  .admin-login-security {
    margin: 0;
    color: #65758d;
    font-size: 13px;
    line-height: 1.6;
  }

  .admin-login-command {
    width: 100%;
    justify-content: space-between;
  }

  .admin-login-command > span,
  .admin-login-security {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .admin-login-security {
    gap: 7px;
    margin-top: -1px;
    color: #7b8ba1;
    font-size: 11px;
    line-height: 1.5;
  }

  @media (max-width: 720px) {
    .admin-login-shell {
      padding: 16px;
    }

    .admin-login-layout {
      min-height: calc(100dvh - 32px);
      grid-template-columns: minmax(0, 480px);
      justify-content: center;
    }

    .admin-login-context {
      display: none;
    }

    .admin-login-card {
      padding: 26px 22px;
    }
  }
  ```

  Retain the existing global `@media (prefers-reduced-motion: reduce)` block; it already disables the new card animation.

- [ ] **Step 4: Rebuild and run both login and CSS tests to verify they pass**

  Run:

  ```bash
  docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx app/globals.css.test.ts --pool=forks --maxWorkers=1'
  ```

  Expected: PASS with the PKCE login flow, semantic title-mark assertions, CSS contract, and reduced-motion contract all green.

- [ ] **Step 5: Commit the visual system changes**

  ```bash
  git add apps/web/app/globals.css apps/web/app/globals.css.test.ts
  git commit -m "feat(web): align admin login with workbench style"
  ```

### Task 3: Validate The Containerized Login Experience

**Files:**
- Modify: none

- [ ] **Step 1: Run the complete affected front-end regression set in Docker**

  Run:

  ```bash
  docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx app/page.test.tsx components/auth/admin-oidc-callback-screen.test.tsx app/globals.css.test.ts --pool=forks --maxWorkers=1'
  ```

  Expected: PASS. This verifies the new login visual structure, root-session redirect, OIDC callback behavior, and CSS motion contract together.

- [ ] **Step 2: Recreate the running web container and wait for the login route**

  Run:

  ```bash
  docker compose up -d --no-deps --force-recreate web
  for attempt in $(seq 1 20); do
    http_code=$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' http://localhost:3000/admin/login || true)
    if [ "$http_code" = "200" ]; then
      printf '%s\n' "$http_code"
      exit 0
    fi
    sleep 2
  done
  docker compose logs --tail=80 web
  exit 1
  ```

  Expected: `200`.

- [ ] **Step 3: Capture desktop and mobile visual checks against the Docker-served route**

  Run:

  ```bash
  export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
  "$PWCLI" open http://localhost:3000/admin/login
  "$PWCLI" resize 1440 900
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" resize 390 844
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" close
  ```

  Expected: the desktop view has a single left-aligned title/logo/command axis and the mobile view has no empty context column or horizontal overflow.

- [ ] **Step 4: Check the final diff and commit the validated implementation if any validation refinement was required**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Expected: no whitespace errors and only the intentional login-entry files modified. If no refinement was required after the Task 2 commit, do not create an empty commit.
