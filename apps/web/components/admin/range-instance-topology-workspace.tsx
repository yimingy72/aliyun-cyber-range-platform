'use client';

import type { XYPosition } from '@xyflow/react';

import { TopologyFlowCanvas } from './template-editor/topology-flow-canvas';
import type { TopologyResourceKind } from './template-editor/topology-flow-resource-rail';
import type { TemplateEdge } from './template-editor/template-editor-screen';
import { TemplatePropertyPanel } from './template-editor/template-property-panel';
import type { TopologySelection, TopologyViewport } from './template-editor/topology-flow-types';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset } from '../../lib/admin-types';
import type { TemplateNode } from '../../lib/scenario-graph';

type NodePositionCommit = {
  id: string;
  position: XYPosition;
};

type RangeInstanceTopologyWorkspaceProps = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport?: TopologyViewport | null;
  selection?: TopologySelection;
  editable?: boolean;
  deployedNodeIds?: string[];
  linkedSwitchIdsByHostId?: Record<string, string[]>;
  platformImageAssets?: PlatformImageAsset[];
  instanceTypeAvailability?: InstanceTypeAvailabilitySnapshot | null;
  runtimeNodeStatus?: string | null;
  onAddNode?: (kind: TopologyResourceKind, position?: XYPosition) => void;
  onConnect?: (connection: { source: string; target: string }) => void;
  onDeleteSelection?: () => void;
  onLayoutAll?: () => void;
  onNodeActivate?: (nodeId: string) => void;
  onPositionsCommit?: (positions: NodePositionCommit[]) => void;
  onRedo?: () => void;
  onSelectionChange?: (selection: TopologySelection) => void;
  onUndo?: () => void;
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void;
  onViewportCommit?: (viewport: TopologyViewport) => void;

  // Compatibility with the old instance-detail caller until it owns Flow state.
  topologyGraph?: Record<string, unknown> | null;
  selectedNodeId?: string | null;
  selectedNode?: TemplateNode | null;
  canOperateInstance?: boolean;
  statusMessage?: string;
  onSelectNode?: (nodeId: string) => void;
  onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void;
};

const emptySelection: TopologySelection = {
  edgeIds: [],
  nodeIds: [],
};

export function RangeInstanceTopologyWorkspace({
  nodes,
  edges,
  viewport = null,
  selection,
  editable,
  deployedNodeIds = [],
  linkedSwitchIdsByHostId = {},
  platformImageAssets = [],
  instanceTypeAvailability = null,
  runtimeNodeStatus = null,
  onAddNode = () => undefined,
  onConnect = () => undefined,
  onDeleteSelection = () => undefined,
  onLayoutAll = () => undefined,
  onNodeActivate,
  onPositionsCommit,
  onRedo = () => undefined,
  onSelectionChange,
  onUndo = () => undefined,
  onUpdateNode,
  onViewportCommit = () => undefined,
  selectedNodeId = null,
  selectedNode: legacySelectedNode = null,
  canOperateInstance = false,
  onSelectNode,
  onMoveNode,
}: RangeInstanceTopologyWorkspaceProps) {
  const isEditable = editable ?? canOperateInstance;
  const effectiveSelection = selection ?? (
    selectedNodeId
      ? { edgeIds: [], nodeIds: [selectedNodeId] }
      : emptySelection
  );
  const selectedNode = nodes.find((node) => node.id === effectiveSelection.nodeIds[0])
    ?? legacySelectedNode;

  function handleSelectionChange(nextSelection: TopologySelection) {
    onSelectionChange?.(nextSelection);
    onSelectNode?.(nextSelection.nodeIds[0] ?? '');
  }

  function handleNodeActivate(nodeId: string) {
    onNodeActivate?.(nodeId);
    onSelectNode?.(nodeId);
  }

  function handlePositionsCommit(positions: NodePositionCommit[]) {
    onPositionsCommit?.(positions);
    positions.forEach(({ id, position }) => onMoveNode?.(id, position));
  }

  return (
    <section className="range-instance-topology-grid" data-testid="range-instance-topology-grid">
      <TopologyFlowCanvas
        edges={edges}
        fullscreenTargetSelector=".range-instance-topology-grid"
        mode={isEditable ? 'edit' : 'readonly'}
        nodes={nodes}
        onAddNode={onAddNode}
        onConnect={onConnect}
        onDeleteSelection={onDeleteSelection}
        onLayoutAll={onLayoutAll}
        onNodeActivate={handleNodeActivate}
        onPositionsCommit={handlePositionsCommit}
        onRedo={onRedo}
        onSelectionChange={handleSelectionChange}
        onUndo={onUndo}
        onViewportCommit={onViewportCommit}
        selection={effectiveSelection}
        viewport={viewport}
      />

      <TemplatePropertyPanel
        allNodes={nodes}
        instanceTypeAvailability={instanceTypeAvailability}
        linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
        onUpdateNode={onUpdateNode}
        platformImageAssets={platformImageAssets}
        readOnly={!isEditable}
        runtimeNodeStatus={runtimeNodeStatus}
        runtimeExistingNode={Boolean(selectedNode && deployedNodeIds.includes(selectedNode.id))}
        selectedNode={selectedNode}
      />
    </section>
  );
}
