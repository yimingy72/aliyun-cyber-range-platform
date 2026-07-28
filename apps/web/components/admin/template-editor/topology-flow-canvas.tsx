'use client';

import React from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type NodeTypes,
  type OnSelectionChangeParams,
  type XYPosition,
} from '@xyflow/react';
import {
  Focus,
  GitBranch,
  LayoutGrid,
  Maximize,
  MousePointer2,
  Redo2,
  Undo2,
} from 'lucide-react';

import { toFlowEdges, toFlowNodes } from './topology-flow-adapter';
import { TopologyFlowNode } from './topology-flow-node';
import {
  TopologyFlowResourceRail,
  type TopologyResourceKind,
} from './topology-flow-resource-rail';
import type { TemplateEdge } from './template-editor-screen';
import type {
  TopologySelection,
  TopologyViewport,
} from './topology-flow-types';
import type { TemplateNode } from '../../../lib/scenario-graph';

const topologyNodeTypes = {
  'topology-router': TopologyFlowNode,
  'topology-switch': TopologyFlowNode,
  'topology-ecs': TopologyFlowNode,
} satisfies NodeTypes;

const topologyFitViewOptions = {
  maxZoom: 1.2,
  padding: 0.45,
} as const;
const resourceNodeFootprint = { height: 96, width: 208 };
const resourcePlacementStep = { x: 240, y: 144 };

type NodePositionCommit = {
  id: string;
  position: XYPosition;
};

type TopologyFlowCanvasProps = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport: TopologyViewport | null;
  onAddNode: (kind: TopologyResourceKind, position?: XYPosition) => void;
  onConnect: (connection: { source: string; target: string }) => void;
  onDeleteSelection: () => void;
  onLayoutAll: () => void;
  onLayoutSelection: () => void;
  onNodeActivate: (nodeId: string) => void;
  onPositionsCommit: (positions: NodePositionCommit[]) => void;
  onRedo: () => void;
  onSelectionChange: (selection: TopologySelection) => void;
  onUndo: () => void;
  onViewportCommit: (viewport: TopologyViewport) => void;
};

function isTopologyResourceKind(value: string): value is TopologyResourceKind {
  return value === 'router' || value === 'switch' || value === 'ecs';
}

function hasSameViewport(
  left: TopologyViewport | null,
  right: TopologyViewport | null,
) {
  return left === right
    || (left?.x === right?.x && left?.y === right?.y && left?.zoom === right?.zoom);
}

function doesResourcePlacementOverlap(
  position: XYPosition,
  existingPosition: XYPosition,
) {
  return position.x < existingPosition.x + resourceNodeFootprint.width
    && position.x + resourceNodeFootprint.width > existingPosition.x
    && position.y < existingPosition.y + resourceNodeFootprint.height
    && position.y + resourceNodeFootprint.height > existingPosition.y;
}

function findResourceInsertionPosition(nodes: TemplateNode[], preferredPosition: XYPosition) {
  const existingPositions = nodes.flatMap((node) => node.position ? [node.position] : []);

  for (let ring = 0; ring <= existingPositions.length + 1; ring += 1) {
    const cardinalOffsets = ring === 0
      ? [{ column: 0, row: 0 }]
      : [
          { column: ring, row: 0 },
          { column: 0, row: ring },
          { column: -ring, row: 0 },
          { column: 0, row: -ring },
        ];

    for (const { column, row } of cardinalOffsets) {
      const candidate = {
        x: preferredPosition.x + column * resourcePlacementStep.x,
        y: preferredPosition.y + row * resourcePlacementStep.y,
      };

      if (!existingPositions.some((position) => doesResourcePlacementOverlap(candidate, position))) {
        return candidate;
      }
    }

    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (
          ring === 0
          || (Math.abs(row) !== ring && Math.abs(column) !== ring)
          || row === 0
          || column === 0
        ) {
          continue;
        }

        const candidate = {
          x: preferredPosition.x + column * resourcePlacementStep.x,
          y: preferredPosition.y + row * resourcePlacementStep.y,
        };

        if (!existingPositions.some((position) => doesResourcePlacementOverlap(candidate, position))) {
          return candidate;
        }
      }
    }
  }

  return preferredPosition;
}

function TopologyFlowCanvasInner({
  edges,
  nodes,
  onAddNode,
  onConnect,
  onDeleteSelection,
  onLayoutAll,
  onLayoutSelection,
  onNodeActivate,
  onPositionsCommit,
  onRedo,
  onSelectionChange,
  onUndo,
  onViewportCommit,
  viewport,
}: TopologyFlowCanvasProps) {
  const [connectMode, setConnectMode] = React.useState(false);
  const [focusMode, setFocusMode] = React.useState(false);
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const { fitView, screenToFlowPosition, setViewport } = useReactFlow();
  const externalFlowNodes = React.useMemo(
    () => toFlowNodes(nodes, connectMode),
    [connectMode, nodes],
  );
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(externalFlowNodes);
  const flowEdges = React.useMemo(() => toFlowEdges(edges), [edges]);
  const syncedFlowNodesRef = React.useRef(externalFlowNodes);
  const knownViewportRef = React.useRef<TopologyViewport | null>(viewport);
  const pendingExternalViewportRef = React.useRef<TopologyViewport | null>(null);

  React.useEffect(() => {
    if (syncedFlowNodesRef.current === externalFlowNodes) {
      return;
    }

    syncedFlowNodesRef.current = externalFlowNodes;
    setFlowNodes(externalFlowNodes);
  }, [externalFlowNodes, setFlowNodes]);

  React.useEffect(() => {
    if (hasSameViewport(knownViewportRef.current, viewport)) {
      return;
    }

    knownViewportRef.current = viewport;

    if (viewport) {
      pendingExternalViewportRef.current = viewport;
      void setViewport(viewport);
      return;
    }

    pendingExternalViewportRef.current = null;
    void fitView({ duration: 180, ...topologyFitViewOptions });
  }, [fitView, setViewport, viewport]);

  function handleConnect(connection: Connection) {
    if (connection.source && connection.target) {
      onConnect({ source: connection.source, target: connection.target });
    }
  }

  function handleSelectionChange({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) {
    onSelectionChange({
      edgeIds: selectedEdges.map((edge) => edge.id),
      nodeIds: selectedNodes.map((node) => node.id),
    });
  }

  function handleNodeClick(event: React.MouseEvent, node: { id: string }) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      return;
    }

    onSelectionChange({
      edgeIds: [],
      nodeIds: [node.id],
    });
    onNodeActivate(node.id);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();

    const kind = event.dataTransfer.getData('application/x-topology-node-kind');
    if (!isTopologyResourceKind(kind)) {
      return;
    }

    onAddNode(
      kind,
      findResourceInsertionPosition(nodes, screenToFlowPosition({ x: event.clientX, y: event.clientY })),
    );
  }

  function handleResourceAddNode(kind: TopologyResourceKind) {
    const bounds = canvasRef.current?.getBoundingClientRect();

    if (!bounds) {
      onAddNode(kind);
      return;
    }

    const preferredPosition = screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    onAddNode(kind, findResourceInsertionPosition(nodes, preferredPosition));
  }

  function handleMoveEnd(nextViewport: TopologyViewport) {
    knownViewportRef.current = nextViewport;

    if (
      pendingExternalViewportRef.current
      && hasSameViewport(pendingExternalViewportRef.current, nextViewport)
    ) {
      pendingExternalViewportRef.current = null;
      return;
    }

    pendingExternalViewportRef.current = null;
    onViewportCommit(nextViewport);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function handleKeyboardShortcut(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFlowNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
      onSelectionChange({ edgeIds: [], nodeIds: [] });
      return;
    }

    if (event.key === 'Delete') {
      event.preventDefault();
      onDeleteSelection();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        onRedo();
      } else {
        onUndo();
      }
      return;
    }

    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      fitView({ duration: 180, ...topologyFitViewOptions });
    }
  }

  return (
    <section
      className="topology-flow-workbench"
      data-connect-mode={connectMode ? 'true' : 'false'}
      data-focus-mode={focusMode ? 'true' : 'false'}
      data-testid="topology-flow-workbench"
      onKeyDown={handleKeyboardShortcut}
      tabIndex={0}
    >
      <div className="topology-flow-toolbar" data-testid="topology-flow-toolbar">
        <button
          aria-label="选择模式"
          aria-pressed={!connectMode}
          className="topology-flow-tool-button"
          data-active={!connectMode ? 'true' : 'false'}
          onClick={() => setConnectMode(false)}
          title="选择模式"
          type="button"
        >
          <MousePointer2 aria-hidden="true" />
        </button>
        <button
          aria-label="连线模式"
          aria-pressed={connectMode}
          className="topology-flow-tool-button"
          data-active={connectMode ? 'true' : 'false'}
          onClick={() => setConnectMode(true)}
          title="连线模式"
          type="button"
        >
          <GitBranch aria-hidden="true" />
        </button>
        <button
          aria-label="全部自动布局"
          className="topology-flow-tool-button"
          onClick={onLayoutAll}
          title="全部自动布局"
          type="button"
        >
          <LayoutGrid aria-hidden="true" />
        </button>
        <button
          aria-label="选中自动布局"
          className="topology-flow-tool-button"
          onClick={onLayoutSelection}
          title="选中自动布局"
          type="button"
        >
          <LayoutGrid aria-hidden="true" />
        </button>
        <button
          aria-label="撤销"
          className="topology-flow-tool-button"
          onClick={onUndo}
          title="撤销"
          type="button"
        >
          <Undo2 aria-hidden="true" />
        </button>
        <button
          aria-label="重做"
          className="topology-flow-tool-button"
          onClick={onRedo}
          title="重做"
          type="button"
        >
          <Redo2 aria-hidden="true" />
        </button>
        <button
          aria-label="适应视图"
          className="topology-flow-tool-button"
          onClick={() => fitView({ duration: 180, ...topologyFitViewOptions })}
          title="适应视图"
          type="button"
        >
          <Maximize aria-hidden="true" />
        </button>
        <button
          aria-label="切换专注模式"
          aria-pressed={focusMode}
          className="topology-flow-tool-button"
          data-active={focusMode ? 'true' : 'false'}
          onClick={() => setFocusMode((value) => !value)}
          title="切换专注模式"
          type="button"
        >
          <Focus aria-hidden="true" />
        </button>
      </div>
      <TopologyFlowResourceRail initialExpanded={nodes.length === 0} onAddNode={handleResourceAddNode} />
      <div className="topology-flow-canvas" data-testid="topology-flow-canvas" ref={canvasRef}>
        <ReactFlow
          defaultViewport={viewport ?? undefined}
          deleteKeyCode={null}
          edges={flowEdges}
          fitView={!viewport}
          fitViewOptions={topologyFitViewOptions}
          minZoom={0.25}
          nodes={flowNodes}
          nodeTypes={topologyNodeTypes}
          onlyRenderVisibleElements
          onConnect={handleConnect}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onMoveEnd={(_event, nextViewport) => handleMoveEnd(nextViewport)}
          onNodeDragStop={(_event, _node, movedNodes) => {
            onPositionsCommit(movedNodes.map((node) => ({ id: node.id, position: node.position })));
          }}
          onNodeClick={handleNodeClick}
          onNodesChange={onNodesChange}
          onSelectionChange={handleSelectionChange}
          multiSelectionKeyCode="Shift"
          panActivationKeyCode="Space"
          panOnDrag={[1]}
          selectionOnDrag
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </section>
  );
}

export function TopologyFlowCanvas(props: TopologyFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <TopologyFlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
