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
  GitBranch,
  LayoutGrid,
  Map as MapIcon,
  Maximize,
  Maximize2,
  Minimize2,
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
  TopologyFlowNode as TopologyFlowNodeState,
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

export type TopologyFlowCanvasMode = 'edit' | 'readonly';

export type TopologyFlowCanvasProps = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  fullscreenTargetSelector?: string;
  mode?: TopologyFlowCanvasMode;
  viewport: TopologyViewport | null;
  onAddNode: (kind: TopologyResourceKind, position?: XYPosition) => void;
  onConnect: (connection: { source: string; target: string }) => void;
  onDeleteSelection: () => void;
  onLayoutAll: () => void;
  onNodeActivate: (nodeId: string) => void;
  onPositionsCommit: (positions: NodePositionCommit[]) => void;
  onRedo: () => void;
  onSelectionChange: (selection: TopologySelection) => void;
  onUndo: () => void;
  onViewportCommit: (viewport: TopologyViewport) => void;
  selection: TopologySelection;
};

function isTopologyResourceKind(value: string): value is TopologyResourceKind {
  return value === 'router' || value === 'switch' || value === 'ecs';
}


function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT'
    || target.isContentEditable;
}

function hasSameViewport(
  left: TopologyViewport | null,
  right: TopologyViewport | null,
) {
  return left === right
    || (left?.x === right?.x && left?.y === right?.y && left?.zoom === right?.zoom);
}

function hasSameTopologySelection(left: TopologySelection, right: TopologySelection) {
  if (left.nodeIds.length !== right.nodeIds.length || left.edgeIds.length !== right.edgeIds.length) {
    return false;
  }

  const leftNodeIds = new Set(left.nodeIds);
  const leftEdgeIds = new Set(left.edgeIds);

  return right.nodeIds.every((nodeId) => leftNodeIds.has(nodeId))
    && right.edgeIds.every((edgeId) => leftEdgeIds.has(edgeId));
}

function applyNodeSelection(
  nodes: TopologyFlowNodeState[],
  selection: TopologySelection,
) {
  const selectedNodeIds = new Set(selection.nodeIds);

  return nodes.map((node) => ({
    ...node,
    selected: selectedNodeIds.has(node.id),
  }));
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
  fullscreenTargetSelector = '.template-editor-grid',
  mode = 'edit',
  nodes,
  onAddNode,
  onConnect,
  onDeleteSelection,
  onLayoutAll,
  onNodeActivate,
  onPositionsCommit,
  onRedo,
  onSelectionChange,
  onUndo,
  onViewportCommit,
  selection,
  viewport,
}: TopologyFlowCanvasProps) {
  const isReadonly = mode === 'readonly';
  const [connectMode, setConnectMode] = React.useState(false);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isMiniMapVisible, setIsMiniMapVisible] = React.useState(false);
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const workbenchRef = React.useRef<HTMLElement>(null);
  const { fitView, screenToFlowPosition, setViewport } = useReactFlow();
  const isConnectMode = !isReadonly && connectMode;
  const topologyFlowNodes = React.useMemo(
    () => toFlowNodes(nodes, edges, isConnectMode),
    [edges, isConnectMode, nodes],
  );
  const externalFlowNodes = React.useMemo(
    () => applyNodeSelection(topologyFlowNodes, selection),
    [selection, topologyFlowNodes],
  );
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(externalFlowNodes);
  const flowEdges = React.useMemo(() => {
    const selectedEdgeIds = new Set(selection.edgeIds);

    return toFlowEdges(nodes, edges).map((edge) => ({
      ...edge,
      selected: selectedEdgeIds.has(edge.id),
    }));
  }, [edges, nodes, selection.edgeIds]);
  const syncedTopologyNodesRef = React.useRef(nodes);
  const syncedConnectModeRef = React.useRef(isConnectMode);
  const syncedEdgesRef = React.useRef(edges);
  const selectionRef = React.useRef(selection);
  const pendingExternalSelectionRef = React.useRef<TopologySelection | null>(null);
  const previousSelectionRef = React.useRef(selection);
  const onSelectionChangeRef = React.useRef(onSelectionChange);
  const knownViewportRef = React.useRef<TopologyViewport | null>(viewport);
  const pendingExternalViewportRef = React.useRef<TopologyViewport | null>(null);
  const pendingFitViewAfterLayoutRef = React.useRef(false);
  const [layoutFitRequestId, setLayoutFitRequestId] = React.useState(0);

  if (!hasSameTopologySelection(previousSelectionRef.current, selection)) {
    previousSelectionRef.current = selection;
    pendingExternalSelectionRef.current = selection;
  }

  selectionRef.current = selection;
  onSelectionChangeRef.current = onSelectionChange;

  React.useEffect(() => {
    const pendingSelection = pendingExternalSelectionRef.current;
    if (!pendingSelection) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (pendingExternalSelectionRef.current === pendingSelection) {
        pendingExternalSelectionRef.current = null;
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [selection]);

  React.useEffect(() => {
    const shouldSyncTopology = syncedTopologyNodesRef.current !== nodes;
    const shouldSyncConnectMode = syncedConnectModeRef.current !== isConnectMode;
    const shouldSyncEdges = syncedEdgesRef.current !== edges;
    syncedTopologyNodesRef.current = nodes;
    syncedConnectModeRef.current = isConnectMode;
    syncedEdgesRef.current = edges;

    setFlowNodes((currentNodes) => {
      const currentNodesById = new Map(currentNodes.map((node) => [node.id, node]));
      let hasChanges = currentNodes.length !== externalFlowNodes.length;
      const nextNodes = externalFlowNodes.map((externalNode) => {
        const currentNode = currentNodesById.get(externalNode.id);

        if (!currentNode) {
          hasChanges = true;
          return externalNode;
        }

        const shouldSyncPosition = shouldSyncTopology
          && (
            currentNode.position.x !== externalNode.position.x
            || currentNode.position.y !== externalNode.position.y
          );
        const shouldSyncNodeData = (shouldSyncTopology || shouldSyncConnectMode || shouldSyncEdges)
          && (
            currentNode.type !== externalNode.type
            || currentNode.data.topologyNode !== externalNode.data.topologyNode
            || currentNode.data.connectMode !== externalNode.data.connectMode
            || currentNode.data.sourcePorts !== externalNode.data.sourcePorts
            || currentNode.data.targetPorts !== externalNode.data.targetPorts
          );
        const shouldSyncSelection = currentNode.selected !== externalNode.selected;

        if (!shouldSyncPosition && !shouldSyncNodeData && !shouldSyncSelection) {
          return currentNode;
        }

        hasChanges = true;
        return {
          ...currentNode,
          ...(shouldSyncNodeData ? { data: externalNode.data, type: externalNode.type } : {}),
          ...(shouldSyncPosition ? { position: externalNode.position } : {}),
          ...(shouldSyncSelection ? { selected: externalNode.selected } : {}),
        };
      });

      return hasChanges ? nextNodes : currentNodes;
    });
  }, [externalFlowNodes, isConnectMode, nodes, setFlowNodes]);

  React.useEffect(() => {
    function syncFullscreenState() {
      setIsFullscreen(document.fullscreenElement === readFullscreenTarget());
    }

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);

    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

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
    if (!isReadonly && connection.source && connection.target) {
      onConnect({ source: connection.source, target: connection.target });
    }
  }

  const reportSelectionChange = React.useCallback((nextSelection: TopologySelection, force = false) => {
    if (!force && hasSameTopologySelection(selectionRef.current, nextSelection)) {
      return;
    }

    onSelectionChangeRef.current(nextSelection);
  }, []);

  const handleSelectionChange = React.useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
    const nextSelection = {
      edgeIds: selectedEdges.map((edge) => edge.id),
      nodeIds: selectedNodes.map((node) => node.id),
    };
    const pendingExternalSelection = pendingExternalSelectionRef.current;

    if (pendingExternalSelection) {
      if (hasSameTopologySelection(pendingExternalSelection, nextSelection)) {
        pendingExternalSelectionRef.current = null;
      }
      return;
    }

    reportSelectionChange(nextSelection);
  }, [reportSelectionChange]);

  function handleNodeClick(event: React.MouseEvent, node: { id: string }) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      return;
    }

    reportSelectionChange({
      edgeIds: [],
      nodeIds: [node.id],
    });
    onNodeActivate(node.id);
  }

  function handleEdgeClick(event: React.MouseEvent, edge: { id: string }) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      return;
    }

    setFlowNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
    reportSelectionChange({
      edgeIds: [edge.id],
      nodeIds: [],
    });
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (isReadonly) {
      return;
    }

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
    if (isReadonly) {
      return;
    }

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
    if (isReadonly) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function readFullscreenTarget() {
    const workbench = workbenchRef.current;

    return workbench?.closest<HTMLElement>(fullscreenTargetSelector) ?? workbench;
  }

  async function handleFullscreenToggle() {
    const fullscreenTarget = readFullscreenTarget();
    if (!fullscreenTarget) {
      return;
    }

    try {
      if (document.fullscreenElement === fullscreenTarget) {
        await document.exitFullscreen();
      } else {
        await fullscreenTarget.requestFullscreen();
      }
    } catch {
      // The browser is the source of truth; fullscreenchange updates the actual state.
    }
  }

  React.useEffect(() => {
    if (!pendingFitViewAfterLayoutRef.current || layoutFitRequestId === 0) {
      return;
    }

    const externalPositions = new Map(
      externalFlowNodes.map((node) => [node.id, node.position] as const),
    );
    const hasSyncedLayoutPositions = flowNodes.length === externalFlowNodes.length
      && flowNodes.every((node) => {
        const position = externalPositions.get(node.id);

        return position != null
          && node.position.x === position.x
          && node.position.y === position.y;
      });

    if (!hasSyncedLayoutPositions) {
      return;
    }

    pendingFitViewAfterLayoutRef.current = false;
    fitView({ duration: 180, ...topologyFitViewOptions });
  }, [externalFlowNodes, fitView, flowNodes, layoutFitRequestId]);

  function handleLayoutAll() {
    pendingFitViewAfterLayoutRef.current = true;
    onLayoutAll();
    setLayoutFitRequestId((current) => current + 1);
  }

  React.useEffect(() => {
    if (isReadonly) {
      return;
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      if (
        event.defaultPrevented ||
        workbenchRef.current?.closest('[hidden], [inert]') ||
        isEditableKeyboardTarget(event.target) ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return;
      }

      event.preventDefault();
      onDeleteSelection();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [isReadonly, onDeleteSelection]);

  function handleKeyboardShortcut(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      if (isFullscreen) {
        return;
      }

      event.preventDefault();
      setFlowNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
      reportSelectionChange({ edgeIds: [], nodeIds: [] }, true);
      return;
    }

    if (isReadonly) {
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
      data-connect-mode={isConnectMode ? 'true' : 'false'}
      data-mode={mode}
      data-testid="topology-flow-workbench"
      onKeyDown={handleKeyboardShortcut}
      ref={workbenchRef}
      tabIndex={0}
    >
      <div className="topology-flow-toolbar" data-testid="topology-flow-toolbar">
        {!isReadonly ? (
          <>
            <button
              aria-label="选择模式"
              aria-pressed={!isConnectMode}
              className="topology-flow-tool-button"
              data-active={!isConnectMode ? 'true' : 'false'}
              onClick={() => setConnectMode(false)}
              title="选择模式"
              type="button"
            >
              <MousePointer2 aria-hidden="true" />
            </button>
            <button
              aria-label="连线模式"
              aria-pressed={isConnectMode}
              className="topology-flow-tool-button"
              data-active={isConnectMode ? 'true' : 'false'}
              onClick={() => setConnectMode(true)}
              title="连线模式"
              type="button"
            >
              <GitBranch aria-hidden="true" />
            </button>
            <button
              aria-label="全部自动布局"
              className="topology-flow-tool-button"
              onClick={handleLayoutAll}
              title="全部自动布局"
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
          </>
        ) : null}
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
          aria-label={isFullscreen ? '退出全屏编辑模式' : '进入全屏编辑模式'}
          aria-pressed={isFullscreen}
          className="topology-flow-tool-button"
          data-active={isFullscreen ? 'true' : 'false'}
          onClick={() => void handleFullscreenToggle()}
          title={isFullscreen ? '退出全屏编辑模式' : '进入全屏编辑模式'}
          type="button"
        >
          {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
      <TopologyFlowResourceRail
        disabled={isReadonly}
        initialExpanded={nodes.length === 0}
        onAddNode={handleResourceAddNode}
      />
      <div className="topology-flow-canvas" data-testid="topology-flow-canvas" ref={canvasRef}>
        <ReactFlow
          defaultViewport={viewport ?? undefined}
          deleteKeyCode={null}
          edges={flowEdges}
          fitView={!viewport}
          fitViewOptions={topologyFitViewOptions}
          minZoom={0.25}
          nodes={flowNodes}
          nodesConnectable={!isReadonly}
          nodesDraggable={!isReadonly}
          nodeTypes={topologyNodeTypes}
          onlyRenderVisibleElements
          onConnect={handleConnect}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onMoveEnd={(_event, nextViewport) => handleMoveEnd(nextViewport)}
          onNodeDragStop={(_event, _node, movedNodes) => {
            if (!isReadonly) {
              onPositionsCommit(movedNodes.map((node) => ({ id: node.id, position: node.position })));
            }
          }}
          onEdgeClick={handleEdgeClick}
          onNodeClick={handleNodeClick}
          onNodesChange={onNodesChange}
          onSelectionChange={handleSelectionChange}
          multiSelectionKeyCode="Shift"
          panActivationKeyCode="Space"
          panOnDrag={isConnectMode ? [1] : [0, 1]}
          selectionOnDrag={false}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          {isMiniMapVisible ? (
            <MiniMap
              className="topology-flow-mini-map"
              pannable
              zoomable
            />
          ) : null}
        </ReactFlow>
      </div>
      <button
        aria-label={isMiniMapVisible ? '隐藏导航图' : '显示导航图'}
        aria-pressed={isMiniMapVisible}
        className="topology-flow-mini-map-toggle"
        onClick={() => setIsMiniMapVisible((visible) => !visible)}
        title={isMiniMapVisible ? '隐藏导航图' : '显示导航图'}
        type="button"
      >
        <MapIcon aria-hidden="true" />
      </button>
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
