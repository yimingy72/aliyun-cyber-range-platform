# Admin Navigation Motion And Interaction Feedback

**Date:** 2026-07-28  
**Status:** Approved for specification review  
**Branch:** `codex/template-state-machine`

## Purpose

Make navigation between admin modules and their nested views feel deliberate
without reducing the platform's compact, workbench-like character. The
experience must provide immediate acknowledgement for clicks, preserve visible
data during revalidation, and avoid abrupt blank or reflowing content.

The change covers the authenticated admin shell and shared interaction
primitives. It does not alter backend contracts, data ownership, permission
rules, route paths, or resource lifecycle behavior.

## Product Direction

This is a high-density operational interface for operators managing images,
instances, templates, ranges, users, billing, and cloud settings. Its motion
language is restrained:

- motion intensity is low to medium; information density remains high
- interactions confirm intent and hierarchy rather than decorate the screen
- the navigation state reacts immediately, while route content arrives with a
  short, stable entrance
- list refreshes retain the last successful snapshot instead of clearing the
  table
- animations must never delay a destructive action, hide a failure, or imply
  that a cloud operation has completed

The design keeps the existing light workspace canvas, compact left navigation,
and Radix/shadcn component foundation. It does not adopt a marketing-page
visual language, large route slides, decorative looping animation, or a dark
security-console theme.

## Component And Dependency Decision

The implementation uses the project's existing `@radix-ui/*` primitives,
shadcn-style local components, Tailwind CSS, and `tw-animate-css`.

No React Bits, Aceternity UI, or Uiverse.io component is added. Those libraries
are useful as visual references or for isolated showcase elements, but their
motion and styling conventions are not an appropriate foundation for a dense
operational application.

The first delivery does not add `motion`/Framer Motion. CSS transitions and
small keyframe animations are sufficient for route entrance, active navigation,
tab selection, overlay entrance, and data-state feedback. A later feature may
adopt `motion` only when it has a concrete need for shared-layout, drag, or
coordinated exit animation that CSS cannot express clearly.

## Shared Motion Contract

Add a business-neutral motion token layer to the web application's global
styles. Tokens define a small fixed set of durations, distances, and easing
curves:

| Interaction | Duration | Movement | Behavior |
| --- | ---: | ---: | --- |
| Pressed control | 80-120ms | 1px or `scale(0.98)` | Immediate tactile acknowledgement |
| Navigation active state | 140-160ms | none | Background, border, text, and icon settle together |
| Tab and segmented view | 140-180ms | indicator only | Indicator moves or grows; panel does not slide across the viewport |
| Page content entrance | 180-220ms | 4-6px upward | Opacity and small vertical settle after a pathname changes |
| Dialog, sheet, menu | 160-200ms | 6-8px | Preserve Radix focus and dismissal semantics |
| Table snapshot replacement | 140-180ms | none | Brief opacity transition only inside the table body |

The common easing is a short decelerating curve such as
`cubic-bezier(0.2, 0.8, 0.2, 1)`. There is no staggered animation for normal
data rows, no full-page lateral slide, and no animation longer than 320ms.

`prefers-reduced-motion: reduce` disables transforms and keyframes. The same
state changes remain visible immediately through color, layout-stable loading
indicators, labels, and ARIA state.

## Shell And Route Behavior

Introduce an `AdminContentTransition` client component inside the authenticated
admin layout. It reads the current pathname and assigns a stable, route-specific
key to the content frame. On pathname changes, only that frame runs the shared
page-entrance animation.

`AdminWorkspaceShell` remains responsible for:

- the current route's active navigation item
- role-based visibility of navigation destinations
- OIDC session hydration, token renewal, and unauthenticated redirect
- responsive navigation-sheet close behavior

The shell additionally keeps a short-lived `pendingHref` after a user activates
a navigation item. The selected item obtains an immediate pending visual state
without blocking browser navigation. The pending state clears when the pathname
matches the destination, on navigation error, or when a different destination
is selected. It is visual feedback only; it does not replace Next.js routing,
prefetch behavior, or error handling.

For a route that suspends while data is obtained, the page continues to render
its stable workspace frame and its local loading state. The content transition
does not show a blank canvas or claim that server-side work is complete.

## Nested Navigation And Controls

Use the same interaction rules for tabs, view toggles, breadcrumbs, pagination,
filters, and row actions:

- Tabs retain their Radix semantics and keyboard navigation. The active indicator
  transitions within the tab list; the panel uses a small opacity transition.
- Toggle groups and pagers use color/border changes plus pressed feedback. They
  do not reanimate surrounding toolbars.
- Search and select filters show focus and pressed feedback, but their values
  update without decorative motion.
- Menu, dialog, sheet, and confirmation states use existing Radix/shadcn
  components and their accessible focus behavior. Motion is limited to their
  surface entrance and exit.
- Buttons keep a fixed width while pending, show the project Spinner where
  appropriate, and remain disabled according to existing business rules.

No new interaction changes a keyboard shortcut, focus order, accessible name,
or confirmation requirement.

## List Loading, Filtering, And Refreshing

List pages distinguish initial loading from revalidation:

1. **Initial load:** retain page header, toolbar, and column geometry; use
   skeleton rows within the table body.
2. **Filter, pagination, and tab refresh with a snapshot:** retain the current
   rows, set the table to `aria-busy="true"`, and show a compact local progress
   indicator. Do not clear the table or animate the whole page.
3. **Long request:** after a 150ms threshold, show the local progress treatment.
   Fast responses do not flash a spinner.
4. **Successful replacement:** swap the table body with a 140-180ms opacity
   transition while retaining table dimensions.
5. **Error with a snapshot:** retain rows and show the existing inline retry
   notice. **Error without a snapshot:** show the standard table-body error
   state.

Feature screens continue to own API requests, query state, view state,
pagination, polling, mutation keys, permissions, and data replacement logic.
The shared layer supplies only presentation conventions and reusable state
containers.

## Accessibility And Performance

- Respect `prefers-reduced-motion` for every new animation.
- Preserve Radix focus trapping, escape handling, and return-focus behavior.
- Use `aria-current`, `aria-busy`, disabled controls, and progress labels to
  communicate state without relying on motion.
- Animate only `opacity` and short `transform` values; never animate layout,
  table dimensions, widths, or arbitrary large paint areas.
- Avoid JavaScript animation loops and event listeners for continuous values.
- Keep route content animation in one shell-level component rather than
  duplicating pathname effects in every screen.

## Scope

### Included

- primary admin navigation feedback
- shared route-content entrance
- tab and view-toggle transitions
- pressed and pending states for shared controls
- stable list initial-load, revalidation, error, and replacement behavior
- shared overlay entrance behavior
- reduced-motion support and focused tests

### Excluded

- backend, worker, database, Keycloak, OpenTofu, or API changes
- route restructuring or changes to navigation labels
- new visual showcase component libraries
- drag-and-drop, physics, parallax, page-wide shared-element transitions, or
  animation on the topology canvas
- redesigning individual domain workflows beyond their shared interaction
  feedback

## Testing And Container Validation

The implementation follows focused test-first development:

- unit tests for motion-class selection and reduced-motion fallbacks
- shell tests for active and pending navigation state, route completion, and
  role-filtered navigation
- component tests for tabs, pressed controls, fixed-size pending buttons, and
  accessible overlay semantics
- list-state tests for initial skeletons, retained snapshots, the 150ms
  progress threshold, successful replacement, and error retention

After any web behavior change:

1. rebuild the affected Docker image
2. run the focused web test suite in Docker
3. recreate the web container against the platform's containerized services
4. check representative routes at desktop and narrow viewports in a real
   browser: image center, instances, scenarios, and range instances
5. enable reduced-motion emulation and repeat the navigation and filter checks
6. inspect browser console errors and verify no layout shift or blank workspace
   occurs during a route or list transition

## Delivery Sequence

1. Add motion tokens, reduced-motion overrides, and focused test helpers.
2. Add shell-level pending navigation feedback and `AdminContentTransition`.
3. Apply the shared contract to tabs, overlays, and common controls.
4. Migrate list refresh states screen by screen, starting with image center,
   instances, scenarios, and range instances.
5. Complete Docker-based regression and visual verification before delivery.
