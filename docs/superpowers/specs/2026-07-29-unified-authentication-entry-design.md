# Unified Authentication Entry Design

## Goal

Make the platform login entry and the Keycloak platform-account form feel like one continuous authentication path. The platform entry removes its left context content and centers the login surface. The Keycloak form adopts the same visual language without changing OIDC, credential validation, realm configuration, or redirect behavior.

## Platform Entry

- Remove the `CYBER RANGE / ADMIN` context column and its supporting sentence from `AdminLoginScreen`.
- Center one login surface in the existing `#f5f7fb` work area at every desktop and mobile viewport.
- Retain the approved left-aligned content axis inside the surface:
  1. `管理入口`
  2. canonical shield mark followed by `登录综合靶场平台`
  3. `使用平台统一账号验证身份并进入管理后台。`
  4. existing OIDC command button
  5. security assurance line
- Retain the existing 6px surface radius, blue command button, 18px explanation-to-command rhythm, and short reduced-motion-aware entry animation.

## Keycloak Platform-Account Form

- Keep the `cyber-range` Keycloak login theme and the existing `platform-web` OIDC client unchanged.
- Replace its legacy centered header, 24px card radius, green gradients, and 14px inputs with the same workbench surface treatment used by the platform entry.
- Center one 420px-wide maximum login surface in the same `#f5f7fb` canvas.
- Render a title block within that surface:
  1. `平台账号认证`
  2. canonical shield mark followed by `登录平台账号`
  3. short statement that the platform account continues to the management workbench
- Keep username and password fields only. Labels, inputs, error state, and submit button align left and use 6px radii.
- Use the platform blue `#1d56a7` for the Keycloak submit button and focus ring; do not add a top bar, hero artwork, gradients, or extra account actions.

## Shared Asset

- The platform entry continues to use `/brand/platform-mark.svg`.
- Add the same SVG as a packaged Keycloak-theme resource at `infra/keycloak/themes/cyber-range/login/resources/img/platform-mark.svg`.
- The Keycloak template references that local theme resource through `${url.resourcesPath}`. It must not load the logo from `localhost:3000`, another public domain, or a data URI.

## Accessibility And States

- Logo images are decorative and have empty alternative text or `aria-hidden`.
- The platform entry retains its existing accessible login button name, disabled submitting state, and inline initialization failure message.
- Keycloak keeps its current form labels, username/password autocomplete attributes, server-side error message wiring, and submit semantics.
- Existing global reduced-motion behavior remains unchanged for the platform entry; Keycloak adds no nonessential motion.

## Verification

- Update platform login tests to assert that no context column is rendered and that the title mark and OIDC flow remain intact.
- Add static regression coverage for the Keycloak theme template and stylesheet: the local logo path, blue submit button, 6px surface/input radii, and absence of legacy green gradients.
- Rebuild and validate both `web` and `keycloak` containers through Docker.
- Use browser screenshots to check the platform entry at desktop and mobile widths, then navigate through the OIDC authorization URL to verify the themed Keycloak form at `localhost:8080`.
