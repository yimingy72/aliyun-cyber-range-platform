# Admin List Workbench Surface

**Date:** 2026-07-23
**Status:** Implemented and verified
**Branch:** `codex/admin-list-workbench-surface`

## Purpose

Finish the visual convergence of authenticated admin pages. Existing shared
tables, toolbars, state rows, and page headers already provide functional
consistency. This iteration makes their surface, header, right-aligned action,
and list-background treatment visually consistent as one compact operational
workbench.

The approved direction is **single workbench surface**:

- the workspace canvas provides a restrained neutral background
- a page has one white operational surface rather than nested cards
- title, description, primary action, search, view controls, table, and
  pagination belong to that one surface
- table headers and rows provide the visual rhythm inside the surface

Domain columns, filters, actions, detail panels, and empty-state guidance
remain specific to each feature.

## Audit Findings

The current list pages share `AdminPageHeader`, `AdminListToolbar`, and
`AdminDataTable` in many places, but presentation remains inconsistent:

- some pages use a white surface containing a second bordered table surface;
  others use a bare table or legacy workbench grid
- some headings use `AdminPageHeader`, while billing and instance management
  have local heading compositions with different font size, weight, spacing,
  and action alignment
- primary commands can appear at different vertical positions relative to the
  title and toolbar
- table frame backgrounds, borders, corner treatment, header fills, and
  pagination spacing vary by page

These differences make each route feel like a related but separate application
even when its data state and controls are already consistent.

## Visual Contract

### Workspace Canvas And Surface

List-oriented routes render on the existing light workspace canvas. Each route
uses one `.admin-workbench-surface`:

- `background`: the semantic card/background token
- one 1px semantic border, 6px corner radius, and restrained shadow
- compact responsive padding: 16px on desktop and 12px on narrow screens
- no child section may introduce a second page-card treatment

The surface is a functional boundary, not a decorative card. A feature can
still place a dialog, an inline notice, or a specialized detail workspace
within it when that content has a different interaction purpose.

### Header And Top-Right Actions

`AdminPageHeader` is the sole shared presentation for page titles:

- title: 20px, semibold, normal letter spacing, foreground token
- description: 14px, muted foreground token, one compact line below the title
- divider: one border below the header with 16px bottom padding
- action slot: right aligned on desktop, naturally wrapped below the copy on
  narrow screens
- primary actions remain feature-owned `Button` instances; button copy, icon,
  permission, disabled, and pending behavior do not change

Billing and single-instance pages will consume the same header composition.
Specialized editor and range-detail headers are not migrated in this iteration
because their canvases and detail controls have different layout needs.

### List Toolbar, Table, And Pagination

The standard list sequence is:

1. shared page header
2. toolbar with a 16px top margin
3. table frame with a 16px top margin
4. pagination with a 16px top margin only when rows exist

`AdminDataTable` owns the table frame treatment:

- white table body background
- one border and 4px table-frame corner radius
- muted, non-gradient header fill
- 44px header height, 12px cell gutters, and existing responsive column
  priority behavior
- existing hover, busy, empty, error, loading, and retained-snapshot behavior
  remains unchanged

Screens must stop adding their own competing table-frame backgrounds or
rounded-card styling around `AdminDataTable`. A wrapper may remain only for
horizontal overflow containment where required.

### Non-Table List Workspaces

Billing remains detail-first rather than becoming a table. It adopts the
shared page header, action alignment, parent surface, and neutral panel
background. Its detail and user-summary panels retain their specialized
semantics, but use the same border, radius, spacing, and header hierarchy as
the list workbench.

Cloud settings remains form-first. It adopts the shared header and parent
surface only. It does not expose, inspect, or alter any credential value.

## Scope

Migrate the common list-workbench treatment on:

- `/admin/users`
- `/admin/image-center`
- `/admin/scenarios`
- `/admin/ranges`
- `/admin/instances`
- `/admin/billing`
- `/admin/settings/cloud`

The implementation may add small shared presentation helpers only when they
remove repeated layout classes. It must not introduce a new package, a generic
page schema, or a visual abstraction that owns feature data or actions.

## Behavioral Invariants

- Feature-specific column names and order remain unchanged.
- API calls, polling, session behavior, authorization, routes, URL query
  state, action handling, and pagination semantics do not change.
- Loading, empty, error, and retained-snapshot states remain in their current
  table or feature workspace.
- Existing keyboard operation, Radix menu portal behavior, dialogs, focus
  handling, and accessible labels remain valid.
- No cloud configuration value, secret, token, bucket identifier, or access
  credential is displayed in audit output or changed by this work.

## Testing And Validation

Use test-first implementation for each shared behavior:

- extend the page-header test to assert the shared action slot and visual
  contract classes
- extend the data-table test to assert the common frame and header classes
- update focused screen tests only where a shared structure changes
- Docker build `web` before each test batch
- run shared-component tests and targeted users, billing, settings, templates,
  image-center, range-state, and single-instance-state tests in a `web`
  container
- recreate only `web`, then inspect user management and billing in the running
  platform on desktop and narrow layouts

The two legacy resource-page full test files with obsolete test harnesses are
not modified by this visual iteration. Focused state tests remain the
regression boundary for their current list-query implementations.

## Non-Goals

- no backend, worker, database, Keycloak, OpenTofu, or API changes
- no global typography redesign outside authenticated admin workbenches
- no migration of the topology editor or range-detail canvas header
- no replacement of feature controls with a fixed global toolbar
- no cloud configuration inspection or credential UI changes
