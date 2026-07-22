# Admin UI Consistency And Refresh Stability

**Date:** 2026-07-22
**Status:** Approved for implementation planning
**Branch:** `codex/admin-ui-consistency`

## Purpose

Extend the existing Tailwind v4 and app-local shadcn/Radix foundation across the
admin workspace. The target is a coherent, compact operational workbench whose
lists retain their domain-specific fields while sharing the same layout,
interaction, loading, empty, and error language.

This work also fixes the refresh experience that can briefly show a default list
or an unrelated layout before the authenticated data state settles.

## Audit Findings

The visual audit covered the authenticated admin routes for image assets, single
instances, range instances, scenarios, users, billing, and cloud settings.

The current problems are:

- New shadcn-based screens coexist with older bespoke workbench CSS, native
  controls, and custom menus.
- Empty states vary from a single text node to a table-like shell, which makes
  an empty page feel unrelated to its loaded state.
- Each screen independently decides when to hide, clear, or replace data while
  the client session hydrates or a request is in flight.
- The single-instance page can show the active-list frame during refresh before
  its actual query and empty state settle.
- Table columns are appropriately domain-specific, but their row density,
  cell gutters, action placement, and responsive collapse rules are not
  consistent.

Cloud-configuration credentials are not included in visual audit artifacts and
must not be exposed by the UI work.

## Product Direction

Keep the approved gradual editor-workbench direction:

- stable light workspace canvas and compact information density
- shallow top bar and a desktop sidebar that becomes a Sheet on narrow screens
- restrained white tool surfaces instead of marketing cards or a dark security
  console
- direct, domain-oriented copy and explicit operational status

The platform must not force all lists into the same field schema. A list should
show the fields its operator needs, while its table framework and interaction
language remain recognizably the same.

## Shared Page Language

Every list page will use the following structural sequence:

1. `AdminPageHeader` for the title, concise context, and primary command.
2. `ListToolbar` for search, scoped filters, tabs or view modes, and nearby
   page controls.
3. A shared dense data-table frame with feature-owned column definitions and
   row rendering.
4. A state inside that same frame: loading, empty, error, or populated rows.
5. Shared pagination only when the active list has rows.

The design system owns:

- table container, header height, row min-height, cell gutters, hover state,
  aligned action column, and responsive column-priority behavior
- `StatusBadge` colors, labels, pending semantics, and accessible status output
- standard buttons, menus, dialogs, confirmations, tooltips, inputs, selects,
  and pagination
- empty/loading/error states with a consistent table footprint

Feature modules own:

- which columns appear and their semantic labels
- API calls, URL parameters, authorization, lifecycle actions, polling, and
  mutation details
- feature-specific primary actions and contextual empty-state guidance

The table frame will support four column priorities. On constrained widths,
secondary metadata columns are hidden before name, state, and action columns
are compressed. It will not turn desktop tables into unstructured card piles.

## Empty, Loading, And Error States

The standard list-state behavior is:

- **Loading without a prior snapshot:** retain the page header, toolbar, and
  feature column headers; render table skeleton rows in the table body.
- **Refresh with a prior snapshot:** retain visible rows, set the table
  `aria-busy` state, and show a local progress indicator rather than clearing
  data.
- **Empty:** retain headers and show a table-body empty state with a small
  utility icon, resource-specific title, one sentence of context, and a
  relevant primary next action only when that action is available.
- **Error without a prior snapshot:** render an actionable error state in the
  table body with Retry.
- **Error with a prior snapshot:** retain rows and show an inline error notice
  with Retry.

For example, an empty single-instance list will say "No instances yet" within
the standard table frame. An empty range-instance list may guide the operator
to create a range from the scenario workflow, but it will use the same
structure, spacing, and state component.

## Session And Refresh Stability

Introduce a single page-readiness contract for protected admin routes:

1. The workspace shell resolves the client session before exposing feature
   content.
2. During session hydration or token renewal, it renders a stable workspace
   skeleton rather than `null`.
3. A child screen begins its data request only after an authenticated session is
   ready.
4. Screen data state distinguishes initial load from revalidation so a refresh
   does not clear a successful snapshot.
5. URL-controlled view mode is read before the first list state is rendered.
   `view=history` remains history after a browser refresh for both single and
   range-instance pages.
6. The shell performs the unauthorized redirect. Child pages report an
   unauthorized result through the shared contract instead of rendering their
   own transitional login surfaces.

This does not change OIDC protocol behavior, stored session format, backend
authorization, or API contracts.

## Surface Migration

The work will be phased to keep each reviewable and container-verifiable.

### Phase 1: Stability And Core Compositions

- Add shared protected-workspace readiness, stable session skeleton, and
  list-query state primitives.
- Add a feature-composable dense table frame and table-body state component.
- Extend shared status and notice compositions without moving API behavior out
  of feature screens.
- Add regression tests for refresh, query-view preservation, state transitions,
  and keyboard-accessible actions.

### Phase 2: Resource And Lifecycle Lists

Migrate:

- `/admin/instances`
- `/admin/ranges`
- `/admin/image-center`

These pages will share the new data-table language while retaining their
specific columns, polling, lifecycle handlers, image workflows, and
credentials-access rules.

### Phase 3: Administrative And Financial Lists

Migrate:

- `/admin/users`
- `/admin/billing`
- `/admin/settings/cloud`

Users retains its identity and role semantics. Billing retains its detail-first
financial layout, but adopts shared controls, statuses, list spacing, notices,
and loading behavior. Cloud settings preserves credential masking and does not
surface secret values in status or audit UI.

### Phase 4: Detail And Editor Surfaces

Migrate the range-detail, scenario-detail, and topology-editor framing only
after the list language is stable. Their operational and canvas-specific
layouts remain specialized; they use shared controls and state boundaries
without being flattened into tables.

## Non-Goals

- no backend, worker, database, Keycloak, or OpenTofu changes
- no API, lifecycle, permission, URL, or pagination-contract changes
- no secret disclosure, browser-storage inspection, or credential UI expansion
- no generic dashboard redesign, dark-console theme, or monorepo UI package
- no replacement of domain-specific fields with a global fixed column schema

## Testing And Validation

Every migration follows test-first development in Docker:

- focused component tests for dense table layout, priorities, empty/loading/
  error states, and session skeleton behavior
- screen tests for empty pages, retained snapshots during revalidation, URL
  view persistence, unauthorized redirect, and pending actions
- explicit tests that view changes do not fetch unrelated tabs or erase active
  data
- web-only image rebuild and runtime verification against the already-running
  platform services
- desktop and narrow browser checks for each migrated route

The current test runner has two unrelated high-memory test files
(`range-instances-screen` and `single-instances-screen`). The migration must
keep their behavior covered through focused tests, but test-memory remediation
is tracked independently from visual behavior changes.
