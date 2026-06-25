'use client';

type TemplateCanvasProps = {
  topologyGraph: Record<string, unknown> | null;
  nodes: Array<{ id: string; kind: string; label: string }>;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
};

export function TemplateCanvas({ topologyGraph, nodes, selectedNodeId, onSelectNode }: TemplateCanvasProps) {
  const nodeCount = Array.isArray(topologyGraph?.nodes) ? topologyGraph?.nodes.length : 0;
  const edgeCount = Array.isArray(topologyGraph?.edges) ? topologyGraph?.edges.length : 0;

  return (
    <section className="template-editor-panel template-canvas-panel">
      <div className="admin-section-header">
        <h2>拓扑画布</h2>
        <span>{nodeCount} 节点 / {edgeCount} 连线</span>
      </div>

      <div className="template-canvas-placeholder">
        <p>画布后续用于放置、拖拽、连线和缩放综合靶场节点。</p>
        <p>当前版本先承载模板草稿的拓扑数据结构。</p>

        {nodes.length ? (
          <div className="template-canvas-node-list">
            {nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className="template-canvas-node"
                aria-pressed={selectedNodeId === node.id}
                onClick={() => onSelectNode(node.id)}
              >
                {node.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="admin-empty">还没有节点，先从左侧节点库添加。</p>
        )}
      </div>
    </section>
  );
}
