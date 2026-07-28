# Topology Flow Canvas Design

## Status

Approved design pending implementation-plan review.

## Context

The template authoring screen currently renders its topology through a bespoke DOM and SVG canvas. It has a finite scene rooted at `(0, 0)`, updates editor state during every drag movement, and rerenders the scene for high-frequency viewport changes. This makes the canvas feel constrained and can become sluggish during normal editing.

The replacement is limited to the template creation and editing screen. The range-instance detail screen keeps its existing read-only canvas for this delivery.

## Goals

- Replace the editable template canvas with a true infinite, pannable, zoomable topology workspace.
- Keep the existing topology JSON, node-property forms, connection validation, compilation, and save APIs compatible.
- Add a minimap, box selection, multi-select actions, auto layout, undo/redo, and collapsible panels.
- Keep dragging, panning, and zooming responsive for templates containing up to several dozen nodes.
- Preserve the immersive workspace direction: a narrow resource tool rail by default, a right-side inspector when a node is selected, and independent panel collapse controls.

## Non-Goals

- No changes to provisioned topology semantics, template compilation, backend APIs, or database migrations.
- No rewrite of the range-instance detail canvas.
- No real-time multi-user editing, comments, or presence indicators.
- No support target for thousands of concurrently visible topology nodes.

## Options Considered

### React Flow

Use `@xyflow/react` with custom router, switch, and ECS node renderers. React Flow supplies the viewport, pointer-centered zoom, panning, selection, connection lifecycle, minimap, and visible-element rendering behavior needed by the authoring experience.

This is the selected approach because the application is React-based, the topology is a node-and-edge workflow graph, and the expected graph size is in the tens of nodes.

### AntV X6

X6 would offer stronger enterprise diagramming primitives, especially ports, grouped nodes, and heavily constrained connection editing. It would add a more imperative rendering model and a larger integration surface for this React editor without providing a proportional benefit for the current topology types.

### Continue the Custom DOM and SVG Canvas

The current approach can be optimized with viewport virtualization and animation-frame batching, but it would still require rebuilding the interaction systems that React Flow already provides. It is not selected.

## Architecture

`TemplateCanvas` will remain available for the range-instance detail screen. The template authoring screen will render a new `TopologyFlowCanvas` component instead.

The new components and helpers are:

- `TopologyFlowCanvas`: owns React Flow configuration, viewport behavior, selection state, panel state, and canvas controls.
- `TopologyFlowNode`: memoized custom node renderer shared by router, switch, and ECS nodes.
- `topology-flow-adapter`: converts the existing `TemplateNode` and `TemplateEdge` values to and from React Flow node and edge values.
- `topology-flow-layout`: computes a deterministic left-to-right router-to-switch-to-ECS layout.
- `topology-flow-history`: stores immutable draft snapshots for undo and redo operations.

The existing template editor remains the owner of persisted draft nodes and edges. The canvas receives those values and reports intent-level changes such as moved nodes, changed connections, selections, and generated layouts.

## Data Compatibility

Existing node records continue to use `TemplateNode`, including all router, switch, ECS, network, image, and security-group fields. The adapter places the complete node record inside the React Flow node `data` payload and maps `TemplateNode.position` to React Flow `position`.

Existing manual edges retain their current shape:

- `TemplateEdge.fromNodeId` maps to React Flow `source`.
- `TemplateEdge.toNodeId` maps to React Flow `target`.
- Edge IDs and labels are preserved.

The graph gains an optional `viewport` record containing numeric `x`, `y`, and `zoom` values. It is ignored by the topology compiler and restored by the authoring canvas when reopening a template. Existing graphs without `viewport` open at the default fit view.

## Workspace Layout

The page keeps its existing header and save actions. Within the workbench:

- The left side defaults to a narrow resource tool rail. Activating a resource opens an overlay palette above the canvas; dragging from it positions a node precisely, while clicking places a node at the visible viewport center.
- The center is an infinite React Flow workspace with a subtle grid, a top-centered mode toolbar, lower-left zoom and fit-view controls, and a lower-right minimap.
- The right inspector is visible for a single selected node and uses the current property-panel fields. It can be collapsed independently.
- A focus control collapses both panels to rails, leaving the workspace, minimap, and canvas toolbar available.

Panel overlay behavior prevents the world viewport from changing width whenever a panel opens or closes, so nodes and connections do not visibly jump.

## Interaction Model

- Dragging empty canvas space pans; wheel events zoom around the pointer; `Space` plus drag also pans; `F` fits the topology into view.
- Clicking a node or edge selects it. Dragging across empty space box-selects; `Shift` adds to a selection; `Esc` clears the selection.
- Single-node selection opens the existing right-side property inspector. Multi-selection exposes only batch-safe actions: move, delete, and auto layout.
- Connection mode requires an ordered source and target selection. The existing manual-edge validation remains authoritative; invalid links are rejected with a local feedback message and never enter the draft.
- `Delete` removes selected nodes and edges through existing cleanup behavior.
- `Ctrl/Cmd + Z` and `Ctrl/Cmd + Shift + Z` traverse draft history.
- Auto layout supports the complete graph or the current selection and feeds its result into the same history.

## Draft History and Saving

The canvas creates a history snapshot for completed user actions: node and edge additions, deletes, connection changes, drag completion, bulk moves, and auto layout. High-frequency pointer movement updates only local presentation state; the editor draft receives the final position when a node drag ends.

Undo and redo operate on local unsaved topology drafts. The existing explicit “检测并保存” action remains the only backend write. Save failures leave the current draft and history intact. Validation failures retain the draft and identify the related node or edge.

## Performance

- Custom node components are memoized and their renderer registrations are module-stable.
- React Flow's visible-element rendering is enabled.
- Position changes are committed after drag completion rather than on every pointer event.
- Panning and zooming stay within React Flow's viewport engine rather than expanding a large DOM scene.
- The minimap and edge rendering remain within the graph renderer, avoiding duplicate geometry calculations.

## Error Handling

- Invalid topology connections continue to use the existing validation rules and message conventions.
- A failed layout calculation leaves nodes in place and displays a non-destructive editor message.
- Missing or malformed optional viewport data falls back to the default fit-view behavior.
- Existing save, compile, and revision-conflict handling remains unchanged.

## Testing

Tests will be written before implementation changes:

- Adapter unit tests for node, edge, and optional viewport round trips.
- History unit tests for completed actions, undo, redo, and redo-branch clearing.
- Layout unit tests for deterministic router, switch, and ECS ordering.
- Canvas component tests for panel collapse state, resource placement intent, box selection behavior, connection rejection, keyboard commands, and viewport restoration.
- Template editor integration tests proving that property updates, existing connection validation, and explicit save behavior continue to work with the new canvas.

## Container Verification

After implementation, the web image will be rebuilt. Tests, build, and browser smoke verification will run through Docker containers and Docker Compose. The smoke flow will verify the editable template page renders the new canvas, supports pan and zoom, opens the resource overlay, collapses panels, creates a permitted connection, undoes it, and retains the draft until explicit save.

