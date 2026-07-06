'use client';

import React from 'react';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from './template-property-panel';

type TemplateCanvasProps = {
  topologyGraph: Record<string, unknown> | null;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  pendingLinkSourceNodeId: string | null;
  statusMessage?: string;
  onSelectNode: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  onOpenNode: (id: string) => void;
  onMoveNode: (id: string, position: { x: number; y: number }) => void;
  onBoardClick?: () => void;
};

type TopologyRelation = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  detail: string;
};

type PositionedNode = TemplateNode & {
  position: {
    x: number;
    y: number;
  };
};

type CanvasViewport = {
  x: number;
  y: number;
  scale: number;
};

const CANVAS_WORLD_MIN_WIDTH = 1400;
const CANVAS_WORLD_MIN_HEIGHT = 900;
const CANVAS_NODE_WIDTH = 176;
const CANVAS_NODE_HEIGHT = 60;
const CANVAS_WORLD_SIDE_PADDING = 360;
const CANVAS_WORLD_BOTTOM_PADDING = 600;
const CANVAS_WORLD_DEFAULT_ORIGIN = {
  x: 0,
  y: 0,
};

function readCanvasNodeMetrics(scale: number) {
  return {
    width: CANVAS_NODE_WIDTH * scale,
    height: CANVAS_NODE_HEIGHT * scale,
    icon: 24 * scale,
    gap: Math.max(6, 10 * scale),
    paddingY: Math.max(6, 10 * scale),
    paddingX: Math.max(8, 12 * scale),
    titleSize: Math.max(11, 13 * scale),
    metaSize: Math.max(10, 12 * scale),
  };
}

function readNodeMeta(node: TemplateNode) {
  if (node.kind === 'ecs') {
    return (
      node.nics?.find((nic) => nic.privateIp.trim().length > 0)?.privateIp ??
      node.networkInterfaces?.find((networkInterface) => networkInterface.privateIp.trim().length > 0)?.privateIp ??
      node.privateIp ??
      ''
    );
  }

  if (node.kind === 'switch') {
    return node.cidr;
  }

  if (node.kind === 'router') {
    return 'VPC 根节点';
  }

  return '';
}

function readNodeIconSrc(kind: TemplateNode['kind']) {
  switch (kind) {
    case 'router':
      return '/topology-icons/router.svg';
    case 'switch':
      return '/topology-icons/switch.svg';
    case 'ecs':
      return '/topology-icons/server.svg';
    default:
      return '/topology-icons/server.svg';
  }
}

function buildManualRelations(nodes: TemplateNode[], edges: TemplateEdge[]): TopologyRelation[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  return edges.flatMap((edge) => {
    const sourceNode = nodeById.get(edge.fromNodeId);
    const targetNode = nodeById.get(edge.toNodeId);

    if (!sourceNode || !targetNode) {
      return [];
    }

    return [
      {
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        label: edge.label ?? `${sourceNode.label} -> ${targetNode.label}`,
        detail: `${sourceNode.label} -> ${targetNode.label}`,
      },
    ];
  });
}

function readNodePosition(node: TemplateNode, index: number): PositionedNode {
  return {
    ...node,
    position: node.position ?? {
      x: 120 + index * 220,
      y: 180,
    },
  };
}

function buildEdgePathWithOrigin(
  sourceNode: PositionedNode,
  targetNode: PositionedNode,
  scale: number,
  origin: { x: number; y: number },
) {
  const metrics = readCanvasNodeMetrics(scale);
  const startX = (sourceNode.position.x - origin.x) * scale + metrics.width - 6;
  const startY = (sourceNode.position.y - origin.y) * scale + metrics.height / 2;
  const endX = (targetNode.position.x - origin.x) * scale + 6;
  const endY = (targetNode.position.y - origin.y) * scale + metrics.height / 2;
  const direction = endX >= startX ? 1 : -1;
  const curveOffset = Math.max(42, Math.abs(endX - startX) * 0.28);

  return `M ${startX} ${startY} C ${startX + curveOffset * direction} ${startY}, ${endX - curveOffset * direction} ${endY}, ${endX} ${endY}`;
}

function readSceneBounds(
  nodes: PositionedNode[],
  lockedOrigin?: { originX: number; originY: number } | null,
) {
  const minX = lockedOrigin?.originX ?? CANVAS_WORLD_DEFAULT_ORIGIN.x;
  const minY = lockedOrigin?.originY ?? CANVAS_WORLD_DEFAULT_ORIGIN.y;
  const maxX = nodes.length
      ? Math.max(
        CANVAS_WORLD_DEFAULT_ORIGIN.x + CANVAS_WORLD_MIN_WIDTH,
        ...nodes.map((node) => node.position.x + CANVAS_NODE_WIDTH + CANVAS_WORLD_SIDE_PADDING),
      )
    : CANVAS_WORLD_DEFAULT_ORIGIN.x + CANVAS_WORLD_MIN_WIDTH;
  const maxY = nodes.length
    ? Math.max(
        CANVAS_WORLD_DEFAULT_ORIGIN.y + CANVAS_WORLD_MIN_HEIGHT,
        ...nodes.map((node) => node.position.y + CANVAS_NODE_HEIGHT + CANVAS_WORLD_BOTTOM_PADDING),
      )
    : CANVAS_WORLD_DEFAULT_ORIGIN.y + CANVAS_WORLD_MIN_HEIGHT;

  return {
    originX: minX,
    originY: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function TemplateCanvas({
  topologyGraph,
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  pendingLinkSourceNodeId,
  statusMessage,
  onSelectNode,
  onSelectEdge,
  onOpenNode,
  onMoveNode,
  onBoardClick,
}: TemplateCanvasProps) {
  const [dragState, setDragState] = React.useState<null | {
    id: string;
    startX: number;
    startY: number;
    pointerX: number;
    pointerY: number;
  }>(null);
  const [dragPreviewPosition, setDragPreviewPosition] = React.useState<null | {
    id: string;
    position: {
      x: number;
      y: number;
    };
  }>(null);
  const [panState, setPanState] = React.useState<null | {
    startX: number;
    startY: number;
    pointerX: number;
    pointerY: number;
  }>(null);
  const [viewport, setViewport] = React.useState<CanvasViewport>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const viewportRef = React.useRef<CanvasViewport>({
    x: 0,
    y: 0,
    scale: 1,
  });
  viewportRef.current = viewport;
  const manualRelations = buildManualRelations(nodes, edges);
  const basePositionedNodes = nodes.map(readNodePosition);
  const positionedNodes = basePositionedNodes.map((node) =>
    dragPreviewPosition && node.id === dragPreviewPosition.id
      ? {
          ...node,
          position: dragPreviewPosition.position,
        }
      : node,
  );
  const positionedNodeById = new Map(positionedNodes.map((node) => [node.id, node]));
  const sceneBounds = readSceneBounds(positionedNodes);
  const sceneWidth = sceneBounds.width;
  const sceneHeight = sceneBounds.height;
  const nodeMetrics = readCanvasNodeMetrics(viewport.scale);

  const didDragRef = React.useRef(false);

  React.useEffect(() => {
    if (!dragState) {
      return;
    }

    const captured = dragState;
    let activated = false;
    const DRAG_THRESHOLD = 4;

    function handleMouseMove(event: MouseEvent) {
      const deltaX = event.clientX - captured.pointerX;
      const deltaY = event.clientY - captured.pointerY;

      if (!activated) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) {
          return;
        }
        activated = true;
        didDragRef.current = true;
      }

      const nextPosition = {
        x: captured.startX + deltaX / viewport.scale,
        y: captured.startY + deltaY / viewport.scale,
      };

      setDragPreviewPosition({
        id: captured.id,
        position: nextPosition,
      });
      onMoveNode(captured.id, nextPosition);
    }

    function handleMouseUp() {
      setDragState(null);
      setDragPreviewPosition(null);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp, { once: true });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, onMoveNode, viewport.scale]);

  return (
    <section className="template-editor-panel template-canvas-panel" data-testid="template-canvas-panel">
      <div className="admin-section-header">
        <div className="template-canvas-heading" data-testid="template-canvas-heading">
          <h2>拓扑画布</h2>
          <span
            className="template-canvas-status"
            data-testid="template-canvas-status-slot"
            aria-hidden={statusMessage ? undefined : 'true'}
          >
            {statusMessage || '\u00A0'}
          </span>
        </div>
        <span>在线编排</span>
      </div>

      <div className="template-canvas-placeholder" data-testid="template-canvas-placeholder" style={{ height: '100%' }}>
        <div
          className="template-canvas-board"
          data-testid="template-canvas-board"
          data-panning={panState ? 'true' : 'false'}
          data-dragging={dragState || dragPreviewPosition ? 'true' : 'false'}
          style={{ height: '100%' }}
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            const target = event.target as HTMLElement;
            if (target.closest('.template-canvas-node')) {
              return;
            }

            const startPointerX = event.clientX;
            const startPointerY = event.clientY;
            const startViewportX = viewportRef.current.x;
            const startViewportY = viewportRef.current.y;
            let panActivated = false;
            let dismissed = false;
            const PAN_THRESHOLD = 8;
            const PAN_DELAY = 150;

            function handlePanMove(moveEvent: MouseEvent) {
              if (dismissed) return;
              const deltaX = moveEvent.clientX - startPointerX;
              const deltaY = moveEvent.clientY - startPointerY;

              if (!panActivated) {
                if (Math.abs(deltaX) < PAN_THRESHOLD && Math.abs(deltaY) < PAN_THRESHOLD) {
                  return;
                }
                panActivated = true;
                setPanState({
                  startX: startViewportX,
                  startY: startViewportY,
                  pointerX: startPointerX,
                  pointerY: startPointerY,
                });
              }

              setViewport((previous) => ({
                ...previous,
                x: startViewportX + deltaX,
                y: startViewportY + deltaY,
              }));
            }

            function handlePanUp() {
              dismissed = true;
              window.removeEventListener('mousemove', handlePanMove);
              if (panActivated) {
                setPanState(null);
              }
            }

            // Delay registering mousemove to ignore trackpad press jitter
            const delayTimer = setTimeout(() => {
              if (!dismissed) {
                window.addEventListener('mousemove', handlePanMove);
              }
            }, PAN_DELAY);

            window.addEventListener('mouseup', () => {
              clearTimeout(delayTimer);
              handlePanUp();
            }, { once: true });
          }}
          onWheel={(event) => {
            event.preventDefault();
            const boardRect = event.currentTarget.getBoundingClientRect();
            const pointerX =
              event.clientX === 0 && event.clientY === 0 && boardRect.width > 0 && boardRect.height > 0
                ? boardRect.width / 2
                : event.clientX - boardRect.left;
            const pointerY =
              event.clientX === 0 && event.clientY === 0 && boardRect.width > 0 && boardRect.height > 0
                ? boardRect.height / 2
                : event.clientY - boardRect.top;

            setViewport((previous) => {
              const nextScale = Math.max(0.6, Math.min(1.8, previous.scale + (event.deltaY < 0 ? 0.1 : -0.1)));
              const worldX = (pointerX - previous.x) / previous.scale;
              const worldY = (pointerY - previous.y) / previous.scale;

              const nextViewport = {
                x: Number((pointerX - worldX * nextScale).toFixed(2)),
                y: Number((pointerY - worldY * nextScale).toFixed(2)),
                scale: Number(nextScale.toFixed(2)),
              };

              return nextViewport;
            });
          }}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (!target.closest('.template-canvas-node')) {
              onBoardClick?.();
            }
          }}
        >
          <div
            className="template-canvas-scene"
            data-testid="template-canvas-scene"
            data-scale={String(viewport.scale)}
            style={{
              width: `${sceneWidth * viewport.scale}px`,
              height: `${sceneHeight * viewport.scale}px`,
              transform: `translate(${viewport.x}px, ${viewport.y}px)`,
            }}
          >
            <svg
              className="template-canvas-svg"
              viewBox={`0 0 ${sceneWidth * viewport.scale} ${sceneHeight * viewport.scale}`}
              aria-hidden="true"
            >
              {manualRelations.map((relation) => {
                const sourceNode = positionedNodeById.get(relation.fromNodeId);
                const targetNode = positionedNodeById.get(relation.toNodeId);

                if (!sourceNode || !targetNode) {
                  return null;
                }

              return (
                <g key={relation.id}>
                  <path
                    className="template-canvas-edge-hit"
                    d={buildEdgePathWithOrigin(sourceNode, targetNode, viewport.scale, {
                      x: sceneBounds.originX,
                      y: sceneBounds.originY,
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectEdge?.(relation.id);
                    }}
                  />
                  <path
                    data-testid={`template-canvas-edge-${relation.id}`}
                    d={buildEdgePathWithOrigin(sourceNode, targetNode, viewport.scale, {
                      x: sceneBounds.originX,
                      y: sceneBounds.originY,
                    })}
                    data-selected={selectedEdgeId === relation.id ? 'true' : 'false'}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectEdge?.(relation.id);
                    }}
                  />
                </g>
              );
            })}
            </svg>

            {positionedNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className="template-canvas-node"
                aria-label={`${node.label} ${readNodeMeta(node)}`.trim()}
                aria-pressed={selectedNodeId === node.id}
                data-link-source={pendingLinkSourceNodeId === node.id ? 'true' : 'false'}
                data-kind={node.kind}
                style={{
                  left: `${(node.position.x - sceneBounds.originX) * viewport.scale}px`,
                  top: `${(node.position.y - sceneBounds.originY) * viewport.scale}px`,
                  width: `${nodeMetrics.width}px`,
                  minHeight: `${nodeMetrics.height}px`,
                  gap: `${nodeMetrics.gap}px`,
                  padding: `${nodeMetrics.paddingY}px ${nodeMetrics.paddingX}px`,
                  gridTemplateColumns: `${nodeMetrics.icon}px minmax(0, 1fr)`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  onSelectNode(node.id);
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();

                  if (event.button !== 0) {
                    return;
                  }

                  didDragRef.current = false;
                  setDragState({
                    id: node.id,
                    startX: node.position.x,
                    startY: node.position.y,
                    pointerX: event.clientX,
                    pointerY: event.clientY,
                  });
                  setDragPreviewPosition({
                    id: node.id,
                    position: node.position,
                  });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenNode(node.id);
                }}
              >
                <img
                  src={readNodeIconSrc(node.kind)}
                  alt=""
                  aria-hidden="true"
                  className="template-canvas-node-icon"
                  data-testid={`template-canvas-icon-${node.id}`}
                  style={{
                    width: `${nodeMetrics.icon}px`,
                    height: `${nodeMetrics.icon}px`,
                  }}
                />
                <span className="template-canvas-node-copy" style={{ gap: `${Math.max(2, 2 * viewport.scale)}px` }}>
                  <strong style={{ fontSize: `${nodeMetrics.titleSize}px` }}>{node.label}</strong>
                  <span style={{ fontSize: `${nodeMetrics.metaSize}px` }}>{readNodeMeta(node)}</span>
                  {pendingLinkSourceNodeId === node.id ? <span style={{ fontSize: `${nodeMetrics.metaSize}px` }}>连线起点</span> : null}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
