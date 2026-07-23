# Frontend Design System Foundation

**Date:** 2026-07-22  
**Status:** Approved for specification review  
**Branch:** `codex/frontend-design-system`

## Purpose

Introduce a maintainable frontend design system for the cloud cyber range platform without changing its backend contracts, authorization behavior, or topology-editor domain logic.

The first delivery will establish the component foundation and migrate two high-impact surfaces:

- the admin workspace shell
- the range-template list at `/admin/scenarios`

This is an incremental refactor. It will preserve the platform's editor-like workspace character rather than applying a generic SaaS dashboard template.

## Product And Visual Direction

The chosen visual direction is **gradual editor workbench**:

- retain the stable left navigation and shallow top bar
- retain the light gray-blue canvas, white workbench surfaces, and compact information density
- improve consistency through shared controls, predictable spacing, semantic status colors, and accessible overlays
- avoid dark security-console styling, decorative gradients, oversized cards, and marketing composition

The desktop sidebar remains approximately `198px`. On constrained viewports, it becomes a `Sheet` navigation drawer while preserving access to every primary module.

## Technical Decisions

### Styling And Component Base

- Add Tailwind CSS v4 to `apps/web`.
- Initialize shadcn/ui in `apps/web`, using the Radix component base.
- Use shadcn-generated source as project-owned code rather than a runtime UI black box.
- Add the `@/*` TypeScript import alias for the web application.
- Keep the existing `app/globals.css` during the transition. Existing pages remain stable while new and migrated components use the new design tokens and utility classes.
- Use Lucide icons for familiar controls and add tooltips when an icon is not self-evident.

Radix is selected for the initial migration because its interaction primitives are mature and provide consistent keyboard and focus behavior for dialogs, menus, selects, tooltips, and responsive navigation.

### Component Boundaries

```text
apps/web/
  components/ui/                 # shadcn-generated, business-neutral primitives
  components/admin/shared/       # reusable platform-specific compositions
  components/admin/*-screen.tsx  # feature state, API calls, routes, and orchestration
  lib/utils.ts                   # class composition helpers
  app/globals.css                # transition CSS and shared design tokens
  components.json                # shadcn CLI configuration
```

`components/ui` includes only visual and interaction primitives such as `Button`, `Dialog`, `Table`, and `Tabs`. It must not call APIs or encode range-template behavior.

`components/admin/shared` composes primitives into platform concepts such as:

- `AdminPageHeader`
- `ListToolbar`
- `StatusBadge`
- `ConfirmActionDialog`
- `AsyncContentState`

Feature screens retain ownership of session state, API calls, URL state, loading orchestration, permissions, and success/error handling. No `packages/ui` workspace package will be added in this phase because the repository currently has one web application. A shared package can be introduced later if a second independent frontend needs the same primitives.

## First Component Set

The initial shadcn/ui installation includes:

- `Button`
- `Input`
- `Select`
- `Tabs`
- `Dialog`
- `DropdownMenu`
- `Tooltip`
- `Table`
- `Badge`
- `Skeleton`
- `Pagination`
- responsive sidebar or sheet primitives as required by the shell

The CLI will install supporting packages required by the selected components. `lucide-react` will supply familiar action icons.

## Workspace Shell Migration

`AdminWorkspaceShell` will be migrated to the new component foundation while keeping:

- current navigation targets and active-route behavior
- user role filtering
- OIDC token renewal and unauthorized redirect behavior
- compact top-bar identity display and logout action

Desktop navigation retains the existing visual hierarchy. On narrow screens, a menu button opens the same navigation entries in a sheet. The navigation does not become a second information architecture.

## Range Template List Migration

`TemplatesScreen` remains the owner of the current session, API, search parameter, pagination, tab lazy-loading, and mutation workflows.

The presentation layer will change as follows:

- an `AdminPageHeader` presents the title, concise context, and the single primary action, "新建拓扑"
- `Tabs` represent "我的拓扑" and "平台拓扑"
- `ListToolbar` combines search, view controls, and pagination controls without changing query behavior
- a dense `Table` presents template name, structure summary, status, update time, and actions
- `Badge` normalizes private/published status presentation
- `DropdownMenu` contains low-frequency row actions
- create, edit, launch, and delete workflows use `Dialog`
- destructive mutations use `ConfirmActionDialog`, which names the target and the effect of the action
- `Skeleton` preserves table geometry while the active view loads
- errors present an actionable retry control, while empty states present only the relevant primary next action

The migration must preserve current create, edit, publish, unpublish, clone, launch, and delete semantics.

## Migration Sequence

The implementation will use three reviewable commits:

1. **Foundation**
   - Tailwind CSS v4, shadcn/ui, aliases, design tokens, shared utility, and primitive component sources.
2. **Admin shared components**
   - platform-level page header, toolbar, status, confirmation, and async-state compositions.
3. **Surface migration**
   - admin workspace shell and range-template list presentation, with existing domain behavior retained.

The topology editor, instance detail workbench, image center, billing, and cloud settings remain out of scope for this initial delivery. They will adopt the foundation in later, independently reviewed migrations.

## Testing And Validation

New behavior is test-first:

- primitive compositions have focused behavior and accessibility tests
- dialogs verify focus-safe close and cancellation behavior
- destructive confirmation verifies the confirm action stays disabled or pending while an operation is in flight
- tabs retain the active view without fetching inactive data
- loading states preserve the stable table geometry

Existing range-template behavior tests remain in place and must continue to pass.

All verification uses Docker:

1. build only the `web` image
2. run web tests inside a container
3. recreate only the `web` service against the already-running API, worker, database, and identity services
4. check the login and range-template routes in a real browser at desktop and narrow viewports
5. inspect browser console output and page resource loading

The production build's route-size output is recorded before and after migration. The range-template route must not introduce an unexplained first-load JavaScript regression, and the previously completed topology-module deferred-loading boundary must remain intact.

## Non-Goals

- no backend API changes
- no data migration
- no authorization model changes
- no topology canvas rewrite
- no dark security-console theme
- no monorepo-wide shared UI package
- no bulk restyling of every admin screen in this branch
