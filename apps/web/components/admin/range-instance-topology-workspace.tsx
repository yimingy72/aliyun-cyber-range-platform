'use client';

import { TemplateCanvas } from './template-editor/template-canvas';
import type { TemplateEdge } from './template-editor/template-editor-screen';
import { TemplatePropertyPanel } from './template-editor/template-property-panel';
import type { TemplateNode } from '../../lib/scenario-graph';

type RangeInstanceTopologyWorkspaceProps = {
  topologyGraph: Record<string, unknown> | null;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  selectedNodeId: string | null;
  selectedNode: TemplateNode | null;
  linkedSwitchIdsByHostId: Record<string, string[]>;
  canOperateInstance: boolean;
  runtimeNodeStatus: string | null;
  statusMessage: string;
  onSelectNode: (nodeId: string) => void;
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void;
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void;
};

export function RangeInstanceTopologyWorkspace({
  topologyGraph,
  nodes,
  edges,
  selectedNodeId,
  selectedNode,
  linkedSwitchIdsByHostId,
  canOperateInstance,
  runtimeNodeStatus,
  statusMessage,
  onSelectNode,
  onMoveNode,
  onUpdateNode,
}: RangeInstanceTopologyWorkspaceProps) {
  return (
    <>
      <div className="range-instance-detail-main range-instance-topology-main">
        <TemplateCanvas
          topologyGraph={topologyGraph}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNodeId}
          pendingLinkSourceNodeId={null}
          statusMessage={statusMessage}
          onSelectNode={onSelectNode}
          onOpenNode={onSelectNode}
          onMoveNode={onMoveNode}
          onBoardClick={() => undefined}
        />
      </div>

      <TemplatePropertyPanel
        selectedNode={selectedNode}
        allNodes={nodes}
        linkedSwitchIdsByHostId={linkedSwitchIdsByHostId}
        onUpdateNode={onUpdateNode}
        readOnly={!canOperateInstance}
        instanceDetailMode
        runtimeNodeStatus={runtimeNodeStatus}
      />
    </>
  );
}
