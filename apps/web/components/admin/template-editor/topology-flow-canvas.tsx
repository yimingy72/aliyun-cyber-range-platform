'use client';

import React from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
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
  onPositionsCommit: (positions: NodePositionCommit[]) => void;
  onRedo: () => void;
  onSelectionChange: (selection: TopologySelection) => void;
  onUndo: () => void;
  onViewportCommit: (viewport: TopologyViewport) => void;
};

function isTopologyResourceKind(value: string): value is TopologyResourceKind {
  return value === 'router' || value === 'switch' || value === 'ecs';
}

function TopologyFlowCanvasInner({
  edges,
  nodes,
  onAddNode,
  onConnect,
  onDeleteSelection,
  onLayoutAll,
  onLayoutSelection,
  onPositionsCommit,
  onRedo,
  onSelectionChange,
  onUndo,
  onViewportCommit,
  viewport,
}: TopologyFlowCanvasProps) {
  const [connectMode, setConnectMode] = React.useState(false);
  const [focusMode, setFocusMode] = React.useState(false);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const flowNodes = React.useMemo(
    () => toFlowNodes(nodes, connectMode),
    [connectMode, nodes],
  );
  const flowEdges = React.useMemo(() => toFlowEdges(edges), [edges]);

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

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();

    const kind = event.dataTransfer.getData('application/x-topology-node-kind');
    if (!isTopologyResourceKind(kind)) {
      return;
    }

    onAddNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function handleKeyboardShortcut(event: React.KeyboardEvent<HTMLElement>) {
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
      fitView({ duration: 180, padding: 0.2 });
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
          onClick={() => fitView({ duration: 180, padding: 0.2 })}
          title="适应视图"
          type="button"
        >
          <Maximize aria-hidden="true" />
        </button>
        <button
          aria-label="切换专注模式"
          className="topology-flow-tool-button"
          data-active={focusMode ? 'true' : 'false'}
          onClick={() => setFocusMode((value) => !value)}
          title="切换专注模式"
          type="button"
        >
          <Focus aria-hidden="true" />
        </button>
      </div>
      <TopologyFlowResourceRail onAddNode={onAddNode} />
      <div className="topology-flow-canvas" data-testid="topology-flow-canvas">
        <ReactFlow
          defaultViewport={viewport ?? undefined}
          deleteKeyCode={null}
          edges={flowEdges}
          fitView={!viewport}
          nodes={flowNodes}
          nodeTypes={topologyNodeTypes}
          onlyRenderVisibleElements
          onConnect={handleConnect}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onMoveEnd={(_event, nextViewport) => onViewportCommit(nextViewport)}
          onNodeDragStop={(_event, _node, movedNodes) => {
            onPositionsCommit(movedNodes.map((node) => ({ id: node.id, position: node.position })));
          }}
          onSelectionChange={handleSelectionChange}
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
