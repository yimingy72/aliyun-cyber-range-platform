# Unified Authentication Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform login entry and Keycloak platform-account form a visually continuous, centered authentication path without changing OIDC, session, or credential-validation behavior.

**Architecture:** Keep the React `AdminLoginScreen` responsible for the existing PKCE redirect and remove only its retired context column. Keep Keycloak's `login.ftl` form semantics intact, moving its existing nested title into a matching title block within one workbench-style card. A root Node static test will make the local Keycloak asset and visual contract independently testable in Docker.

**Tech Stack:** Next.js 15, React, TypeScript, CSS, Keycloak FreeMarker theme, Node.js `node:test`, Vitest, Testing Library, Docker Compose, Playwright CLI.

---

## File Structure

- Modify: `apps/web/components/auth/admin-login-screen.tsx`
  - Remove the retired `admin-login-context` `<aside>` while leaving PKCE state, failure state, and button behavior unchanged.
- Modify: `apps/web/app/admin/login/page.test.tsx`
  - Assert that the retired context copy is absent while retaining the title-mark and OIDC redirect coverage.
- Modify: `apps/web/app/globals.css`
  - Replace the desktop two-column login layout with a single centered 420px surface and remove context-column CSS.
- Modify: `apps/web/app/globals.css.test.ts`
  - Lock the centered single-surface layout contract without relying on browser measurements.
- Create: `test/keycloak-login-theme.test.mjs`
  - Statically verify local Keycloak logo packaging, preserved form semantics, blue controls, 6px radii, and retirement of the green-gradient treatment.
- Create: `infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg`
  - Package a byte-identical Keycloak-local copy of the canonical platform mark.
- Modify: `infra/keycloak/themes/cyber-range/login/template.ftl`
  - Put the Keycloak title block and local logo inside the existing card, preserving nested message, form, and info slots.
- Modify: `infra/keycloak/themes/cyber-range/login/resources/css/styles.css`
  - Apply the platform workbench surface, left-aligned form, blue submit button, and responsive insets to the Keycloak theme.

### Task 1: Remove The Retired Platform Context Column

**Files:**
- Modify: `apps/web/app/admin/login/page.test.tsx:125-139`
- Modify: `apps/web/components/auth/admin-login-screen.tsx:40-89`

- [ ] **Step 1: Extend the existing semantic login test with the failing absence assertions**

  In the existing `renders the workbench-aligned entry title with the canonical platform mark` test, append these assertions after the security-line assertion:

  ```tsx
  expect(screen.queryByText('CYBER RANGE / ADMIN')).toBeNull();
  expect(screen.queryByText('统一身份验证完成后，继续进入综合靶场管理工作台。')).toBeNull();
  ```

- [ ] **Step 2: Build the current web image and verify the semantic test fails**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx --pool=forks --maxWorkers=1'
  ```

  Expected: FAIL in the new absence assertion because the current component still renders `CYBER RANGE / ADMIN`.

- [ ] **Step 3: Remove only the context `<aside>` from the login layout**

  In `apps/web/components/auth/admin-login-screen.tsx`, replace the start of the returned layout:

  ```tsx
  <div className="admin-login-layout">
    <aside aria-hidden="true" className="admin-login-context">
      <strong>CYBER RANGE / ADMIN</strong>
      <p>统一身份验证完成后，继续进入综合靶场管理工作台。</p>
    </aside>

    <section aria-labelledby="admin-login-title" className="admin-login-card">
  ```

  with:

  ```tsx
  <div className="admin-login-layout">
    <section aria-labelledby="admin-login-title" className="admin-login-card">
  ```

  Leave `handleLogin`, `errorMessage`, `isSubmitting`, the canonical `/brand/platform-mark.svg`, the accessible button name, and `window.location.assign(authorization.url)` unchanged.

- [ ] **Step 4: Rebuild and verify the focused semantic and OIDC test passes**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx --pool=forks --maxWorkers=1'
  ```

  Expected: PASS with the existing PKCE redirect, session storage, title-mark, and new absence assertions green.

- [ ] **Step 5: Commit the structural change**

  ```bash
  git add apps/web/components/auth/admin-login-screen.tsx apps/web/app/admin/login/page.test.tsx
  git commit -m "fix(web): center admin login entry"
  ```

### Task 2: Make The Platform Entry A Single Centered Surface

**Files:**
- Modify: `apps/web/app/globals.css:1138-1274`
- Modify: `apps/web/app/globals.css.test.ts:114-131`

- [ ] **Step 1: Replace the old two-column CSS contract with a failing centered-surface contract**

  Replace `defines the compact workbench-aligned admin login entry` in `apps/web/app/globals.css.test.ts` with:

  ```tsx
  it('defines a centered single-surface admin login entry', () => {
    const loginShell = getRuleBlock(stylesheet, '.admin-login-shell');
    const loginLayout = getRuleBlock(stylesheet, '.admin-login-layout');
    const loginCard = getRuleBlock(stylesheet, '.admin-login-card');
    const loginForm = getRuleBlock(stylesheet, '.admin-login-form');
    const loginCommand = getRuleBlock(stylesheet, '.admin-login-command');
    const narrowScreenRules = getAtRuleBlock(stylesheet, '@media (max-width: 720px)');

    expect(loginShell).toContain('background: #f5f7fb');
    expect(loginShell).toContain('place-items: center');
    expect(loginLayout).toContain('width: min(420px, 100%)');
    expect(loginLayout).not.toContain('grid-template-columns');
    expect(loginCard).toContain('border-radius: 6px');
    expect(loginCard).toContain('padding: 34px');
    expect(loginCard).toContain('animation: admin-content-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both');
    expect(loginForm).toContain('gap: 18px');
    expect(loginCommand).toContain('justify-content: space-between');
    expect(stylesheet).not.toContain('.admin-login-context');
    expect(getRuleBlock(narrowScreenRules, '.admin-login-shell')).toContain('padding: 16px');
    expect(getRuleBlock(narrowScreenRules, '.admin-login-card')).toContain('padding: 26px 22px');
  });
  ```

- [ ] **Step 2: Build the current web image and verify the CSS contract fails**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/globals.css.test.ts --pool=forks --maxWorkers=1'
  ```

  Expected: FAIL because the current layout has a two-column `grid-template-columns` rule, does not center grid items, still contains `.admin-login-context`, and retains a 17px form gap.

- [ ] **Step 3: Replace the login layout CSS with the centered contract**

  In `apps/web/app/globals.css`, replace the `.admin-login-shell` through the `@media (max-width: 720px)` login rules with:

  ```css
  .admin-login-shell {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #f5f7fb;
  }

  .admin-login-layout {
    width: min(420px, 100%);
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
    gap: 18px;
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

    .admin-login-card {
      padding: 26px 22px;
    }
  }
  ```

  Do not add a header, hero, secondary panel, or new interaction state. Retain the existing global `@media (prefers-reduced-motion: reduce)` rules so the card animation remains disabled for users who request reduced motion.

- [ ] **Step 4: Rebuild and verify the platform behavior and CSS contract pass**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx app/globals.css.test.ts --pool=forks --maxWorkers=1'
  ```

  Expected: PASS with one centered login-surface contract, preserved 6px card radius, blue command layout, and the previous OIDC tests.

- [ ] **Step 5: Commit the layout change**

  ```bash
  git add apps/web/app/globals.css apps/web/app/globals.css.test.ts
  git commit -m "style(web): unify admin login surface"
  ```

### Task 3: Align The Keycloak Theme And Add Static Regression Coverage

**Files:**
- Create: `test/keycloak-login-theme.test.mjs`
- Create: `infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg`
- Modify: `infra/keycloak/themes/cyber-range/login/template.ftl:37-65`
- Modify: `infra/keycloak/themes/cyber-range/login/resources/css/styles.css:1-190`

- [ ] **Step 1: Add the failing static Keycloak-theme regression test**

  Create `test/keycloak-login-theme.test.mjs` with:

  ```js
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import test from 'node:test';

  const template = fs.readFileSync(
    new URL('../infra/keycloak/themes/cyber-range/login/template.ftl', import.meta.url),
    'utf8',
  );
  const loginTemplate = fs.readFileSync(
    new URL('../infra/keycloak/themes/cyber-range/login/login.ftl', import.meta.url),
    'utf8',
  );
  const stylesheet = fs.readFileSync(
    new URL('../infra/keycloak/themes/cyber-range/login/resources/css/styles.css', import.meta.url),
    'utf8',
  );
  const platformMark = new URL('../apps/web/public/brand/platform-mark.svg', import.meta.url);
  const themeMark = new URL(
    '../infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg',
    import.meta.url,
  );

  test('packages the canonical platform mark inside the Keycloak login theme', () => {
    assert.ok(fs.existsSync(themeMark), 'Keycloak theme should package its own platform mark');
    assert.equal(fs.readFileSync(themeMark, 'utf8'), fs.readFileSync(platformMark, 'utf8'));
    assert.match(template, /src="\$\{url\.resourcesPath\}\/img\/platform-mark\.svg"/);
    assert.doesNotMatch(template, /(localhost:3000|https?:\/\/|data:image)/);
  });

  test('keeps the Keycloak title and credential form semantics inside the login card', () => {
    assert.match(template, /class="cr-login-card"/);
    assert.match(template, /平台账号认证/);
    assert.match(template, /<#nested "header">/);
    assert.match(template, /<#nested "form">/);
    assert.match(loginTemplate, /name="username"/);
    assert.match(loginTemplate, /name="password"/);
    assert.match(loginTemplate, /autocomplete="username"/);
    assert.match(loginTemplate, /autocomplete="current-password"/);
    assert.match(loginTemplate, /id="kc-login"[^>]*type="submit"/);
    assert.match(loginTemplate, /messagesPerField\.existsError\('username','password'\)/);
  });

  test('uses the blue workbench login treatment instead of the retired green gradient', () => {
    assert.match(stylesheet, /\.cr-login-shell\s*\{[^}]*background: #f5f7fb/s);
    assert.match(stylesheet, /\.cr-login-card\s*\{[^}]*border-radius: 6px;[^}]*background: #ffffff/s);
    assert.match(stylesheet, /\.cr-form-input\s*\{[^}]*border-radius: 6px;/s);
    assert.match(stylesheet, /\.cr-login-button\s*\{[^}]*border-radius: 6px;[^}]*background: #1d56a7;/s);
    assert.match(stylesheet, /\.cr-form-input:focus[\s\S]*border-color: #1d56a7;/);
    assert.doesNotMatch(stylesheet, /linear-gradient\(|#214d46|#183230|border-radius: 24px|border-radius: 14px/);
  });
  ```

- [ ] **Step 2: Build the current web image and verify the new static test fails**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'node --test test/keycloak-login-theme.test.mjs'
  ```

  Expected: FAIL because the Keycloak-local SVG does not exist and the current theme still has the legacy split header, green gradient, 24px card, and 14px input radii.

- [ ] **Step 3: Package the canonical logo and move the Keycloak title block inside the card**

  Create `infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg` through `apply_patch` with byte-for-byte identical content from `apps/web/public/brand/platform-mark.svg`.

  In `infra/keycloak/themes/cyber-range/login/template.ftl`, replace the current `<div class="cr-login-shell">` body with:

  ```ftl
  <div class="cr-login-shell">
    <div class="cr-login-wrap">
      <main class="cr-login-card">
        <header id="kc-header" class="cr-login-copy">
          <span class="cr-login-eyebrow">平台账号认证</span>
          <div class="cr-login-title-row">
            <img
              alt=""
              aria-hidden="true"
              class="cr-login-title-mark"
              height="31"
              src="${url.resourcesPath}/img/platform-mark.svg"
              width="31"
            />
            <h1 id="kc-page-title" class="cr-login-title"><#nested "header"></h1>
          </div>
          <p class="cr-login-subtitle">使用平台账号继续进入综合靶场管理工作台。</p>
        </header>

        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="cr-alert cr-alert-${(message.type = 'error')?then('danger', message.type)}">
                <span class="cr-alert-text">${kcSanitize(message.summary)?no_esc}</span>
            </div>
        </#if>

        <#nested "form">

        <#if displayInfo>
          <div id="kc-info" class="cr-login-info">
              <div id="kc-info-wrapper">
                  <#nested "info">
              </div>
          </div>
        </#if>
      </main>

      <@loginFooter.content/>
    </div>
  </div>
  ```

  This consumes the existing `login.ftl` header value `登录平台账号` rather than duplicating it, preserves all server-rendered message and form slots, and loads the shield only from the Keycloak theme's `resources/img` directory.

- [ ] **Step 4: Replace the Keycloak stylesheet with the shared workbench treatment**

  Replace `infra/keycloak/themes/cyber-range/login/resources/css/styles.css` with:

  ```css
  html,
  body {
    min-height: 100%;
  }

  html.login-pf,
  html.login-pf body,
  body.login-pf {
    margin: 0;
    background: #f5f7fb;
    color: #1d2b44;
    font-family: "IBM Plex Sans", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  }

  .cr-login-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #f5f7fb;
  }

  .cr-login-wrap {
    width: min(420px, 100%);
  }

  .cr-login-card {
    width: 100%;
    box-sizing: border-box;
    padding: 34px;
    border: 1px solid #dbe5f0;
    border-radius: 6px;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(24, 44, 74, 0.06);
  }

  .cr-login-copy {
    display: grid;
    gap: 9px;
    margin-bottom: 18px;
    text-align: left;
  }

  .cr-login-eyebrow {
    color: #4d76aa;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.1em;
  }

  .cr-login-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .cr-login-title-mark {
    width: 31px;
    height: 31px;
    flex: 0 0 auto;
  }

  .cr-login-title {
    margin: 0;
    color: #22314d;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.25;
  }

  .cr-login-subtitle {
    margin: 0;
    color: #65758d;
    font-size: 13px;
    line-height: 1.6;
  }

  .cr-login-form {
    display: grid;
    gap: 18px;
  }

  .cr-form-group {
    display: grid;
    gap: 8px;
  }

  .cr-form-label {
    color: #33415c;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
  }

  .cr-form-input {
    width: 100%;
    height: 46px;
    box-sizing: border-box;
    border: 1px solid #d7dfe9;
    border-radius: 6px;
    background: #ffffff;
    padding: 0 12px;
    color: #1d2b44;
    font: inherit;
    outline: none;
  }

  .cr-form-input:hover {
    border-color: #b8c7dc;
  }

  .cr-form-input:focus,
  .cr-form-input:focus-visible {
    border-color: #1d56a7;
    box-shadow: 0 0 0 3px rgba(29, 86, 167, 0.14);
  }

  .cr-form-input:-webkit-autofill,
  .cr-form-input:-webkit-autofill:hover,
  .cr-form-input:-webkit-autofill:focus,
  .cr-form-input:-webkit-autofill:active {
    -webkit-text-fill-color: #1d2b44 !important;
    -webkit-box-shadow: 0 0 0 1000px #ffffff inset !important;
    transition: background-color 9999s ease-in-out 0s;
  }

  .cr-form-error {
    margin: -4px 0 0;
    color: #bf3f45;
    font-size: 13px;
    line-height: 1.5;
  }

  .cr-login-button {
    width: 100%;
    min-height: 46px;
    margin-top: 0;
    border: 0;
    border-radius: 6px;
    background: #1d56a7;
    color: #ffffff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .cr-login-button:hover,
  .cr-login-button:focus,
  .cr-login-button:active {
    background: #184b97;
  }

  .cr-login-button:focus-visible {
    outline: 3px solid rgba(29, 86, 167, 0.24);
    outline-offset: 2px;
  }

  .cr-alert {
    margin: 0 0 18px;
    border: 1px solid #efc4c7;
    border-radius: 6px;
    background: #fff5f5;
    padding: 12px;
    color: #a63238;
    font-size: 13px;
    line-height: 1.5;
  }

  .cr-login-info {
    margin-top: 18px;
    color: #65758d;
    font-size: 13px;
    line-height: 1.6;
    text-align: left;
  }

  .cr-login-info a {
    color: #1d56a7;
    font-weight: 600;
    text-decoration: none;
  }

  .cr-login-info a:hover {
    color: #184b97;
    text-decoration: underline;
  }

  #login-footer,
  .pf-v5-c-login__main-footer,
  #kc-content,
  #kc-content-wrapper,
  #kc-attempted-username,
  button[data-password-toggle],
  .pf-v5-c-login,
  .pf-v5-c-login__container,
  .pf-v5-c-login__main,
  .pf-v5-c-login__main-header,
  .pf-v5-c-login__main-body {
    all: unset;
  }

  @media (max-width: 640px) {
    .cr-login-shell {
      padding: 16px;
    }

    .cr-login-card {
      padding: 26px 22px;
    }
  }
  ```

  Keep `login.ftl` unchanged: its username/password inputs, autocomplete values, error wiring, hidden credential field, and submit semantics are already the required behavior.

- [ ] **Step 5: Rebuild and verify the static Keycloak-theme contract passes**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'node --test test/keycloak-login-theme.test.mjs'
  ```

  Expected: PASS with the exact local SVG match, nested header/form slots, preserved credential semantics, blue controls, 6px surface/input radii, and no legacy gradient tokens.

- [ ] **Step 6: Commit the Keycloak theme and regression test**

  ```bash
  git add \
    test/keycloak-login-theme.test.mjs \
    infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg \
    infra/keycloak/themes/cyber-range/login/template.ftl \
    infra/keycloak/themes/cyber-range/login/resources/css/styles.css
  git commit -m "feat(keycloak): unify platform account login"
  ```

### Task 4: Validate The Docker-Served Authentication Path

**Files:**
- Modify: none

- [ ] **Step 1: Run the complete affected automated regression set in Docker**

  Run:

  ```bash
  COMPOSE_BAKE=false docker compose build web
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'cd apps/web && pnpm exec vitest run app/admin/login/page.test.tsx app/page.test.tsx components/auth/admin-oidc-callback-screen.test.tsx app/globals.css.test.ts --pool=forks --maxWorkers=1'
  docker compose run --rm --no-deps -e NODE_ENV=test web sh -lc \
    'node --test test/keycloak-login-theme.test.mjs'
  ```

  Expected: all affected Vitest suites and all Keycloak static-theme tests pass in the rebuilt container image.

- [ ] **Step 2: Recreate the affected runtime containers and verify readiness**

  Run:

  ```bash
  docker compose up -d --no-deps --force-recreate web
  docker compose up -d --no-deps --force-recreate keycloak
  docker compose run --rm --no-deps keycloak-bootstrap

  for attempt in $(seq 1 30); do
    web_status=$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' http://localhost:3000/admin/login || true)
    keycloak_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://localhost:8080/realms/cyber-range/.well-known/openid-configuration || true)
    if [ "$web_status" = "200" ] && [ "$keycloak_status" = "200" ]; then
      printf 'web=%s keycloak=%s\n' "$web_status" "$keycloak_status"
      break
    fi
    sleep 2
  done

  test "${web_status:-}" = "200"
  test "${keycloak_status:-}" = "200"
  docker compose ps web keycloak keycloak-bootstrap
  ```

  Expected: `web=200 keycloak=200`; `web` and `keycloak` are running, and the re-run bootstrap exits successfully after reapplying `loginTheme=cyber-range`.

- [ ] **Step 3: Capture desktop and mobile screenshots of the Docker-served platform entry**

  Run the Playwright CLI in a clean named session so it does not reuse an existing browser authentication state:

  ```bash
  export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
  export PLAYWRIGHT_CLI_SESSION=unified-authentication-entry

  mkdir -p output/playwright/unified-authentication-entry
  cd output/playwright/unified-authentication-entry
  "$PWCLI" close || true
  "$PWCLI" open http://localhost:3000/admin/login --headed
  "$PWCLI" resize 1440 900
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" resize 390 844
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" console error
  "$PWCLI" close
  cd ../../..
  ```

  Expected: both screenshots show one centered white card on `#f5f7fb`; title, copy, command, and security line remain left-aligned inside the card; there is no top bar, empty desktop column, horizontal overflow, or browser console error.

- [ ] **Step 4: Open Keycloak with a valid fresh PKCE authorization request and capture the themed account form**

  Run:

  ```bash
  export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
  export PLAYWRIGHT_CLI_SESSION=unified-authentication-keycloak

  verifier="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
  challenge="$(node -e 'const crypto = require("node:crypto"); console.log(crypto.createHash("sha256").update(process.argv[1]).digest("base64url"))' "$verifier")"
  authorization_url="http://localhost:8080/realms/cyber-range/protocol/openid-connect/auth?client_id=platform-web&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fadmin%2Fcallback&response_type=code&scope=openid&code_challenge_method=S256&code_challenge=${challenge}&state=theme-check"

  mkdir -p output/playwright/unified-authentication-keycloak
  cd output/playwright/unified-authentication-keycloak
  "$PWCLI" close || true
  "$PWCLI" open "$authorization_url" --headed
  "$PWCLI" resize 1440 900
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" resize 390 844
  "$PWCLI" snapshot
  "$PWCLI" screenshot
  "$PWCLI" console error
  "$PWCLI" close
  cd ../../..
  ```

  Expected: Keycloak renders the `平台账号认证` eyebrow, local shield mark, `登录平台账号` heading, short workbench continuation statement, username/password labels and fields, error-ready form wiring, and blue 6px-radius submit button inside the same centered white surface. Do not enter credentials or submit the form during this visual check.

- [ ] **Step 5: Inspect the final change set and create a final verification commit only when needed**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Expected: no whitespace errors and only the planned authentication-entry files plus generated, ignored `output/playwright/` artifacts. If no post-validation refinement was required after Tasks 1-3, do not create an empty commit.
