# Admin Login Entry Design

## Goal

Redesign the administrator login entry so it reads as a focused part of the existing management workbench rather than a standalone marketing card. The existing OIDC login flow, pending-login storage, and failure behavior remain unchanged.

## Layout

- Render a full-height `#f5f7fb` work surface with no white top bar.
- Use a desktop two-column composition inside a constrained content area:
  - A quiet left context column shows only `CYBER RANGE / ADMIN` and one short supporting sentence.
  - A right login surface contains all actionable content.
- Collapse to the login surface alone below the existing mobile breakpoint; do not retain an empty context area.
- Use one framed login surface only. It keeps the workbench's white background, 1px border, 6px radius, and restrained shadow.

## Login Surface

All informational text aligns to one left edge:

1. Small `管理入口` label.
2. Title row containing the canonical shield asset followed by `登录综合靶场平台`.
3. Supporting copy: `使用平台统一账号验证身份并进入管理后台。`
4. Primary OIDC command.
5. A small security assurance line.

The canonical asset remains `/brand/platform-mark.svg`; it appears once, directly before the login title. The page must not add a duplicate logo in a top bar.

## Controls And States

- Reuse the existing `Button` component for the OIDC command and Lucide `LogIn` and `ArrowRight` icons.
- The button follows the workbench command pattern: icon and label start-aligned, arrow end-aligned. It spans the login surface without centering its text.
- Keep the existing disabled and `正在跳转...` state while the authorization URL is being created.
- Keep the existing inline error message when authorization setup fails. It occupies the same content axis and does not change the layout structure.
- Keep the security line beneath the command, using a compact Lucide security icon rather than decorative artwork.

## Visual Rhythm And Motion

- Remove the former internal divider between supporting copy and the primary command.
- Use an 18px gap from supporting copy to the primary command and a smaller 16px gap from command to security text.
- Match existing backend colors: `#f5f7fb` work surface, white card, `#1d56a7` primary action, and muted blue-gray supporting text.
- Reuse the existing 200ms short fade-and-rise motion rhythm. The current global `prefers-reduced-motion` rule continues to disable motion.
- Do not add gradients, decorative orbs, large illustrations, or hero marketing copy.

## Implementation Boundaries

- Update `apps/web/components/auth/admin-login-screen.tsx` and the associated login styles in `apps/web/app/globals.css`.
- Reuse the existing logo asset and shared UI components; do not alter OIDC helper behavior, session storage, callbacks, API contracts, or routes.
- Keep the current login form landmark and accessible button name.

## Verification

- Add test-first coverage that the login title includes the canonical platform mark and retains the OIDC login button behavior.
- Cover the submitting and authorization failure states without depending on layout-specific browser measurements.
- Build the `web` image and run the affected login and authentication tests inside Docker.
- Recreate the `web` container and verify `/admin/login` responds successfully.
