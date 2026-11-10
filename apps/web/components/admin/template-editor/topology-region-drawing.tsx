'use client';

import React from 'react';
import type { XYPosition } from '@xyflow/react';
import { MAX_REGION_COORDINATE, MAX_REGION_SIZE, MIN_REGION_SIZE, type TopologyRegionBounds } from '@aliyun-cyber-range/scenario-runtime';

function rectangle(from: XYPosition, to: XYPosition): TopologyRegionBounds {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

export function TopologyRegionDrawing({ toFlow, onDraw, onCancel }: {
  toFlow: (point: XYPosition) => XYPosition;
  onDraw: (bounds: TopologyRegionBounds) => void;
  onCancel: () => void;
}) {
  const surface = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ pointerId: number; start: XYPosition } | null>(null);
  const [preview, setPreview] = React.useState<TopologyRegionBounds | null>(null);
  React.useEffect(() => surface.current?.focus(), []);

  function commit(bounds: TopologyRegionBounds) {
    const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));
    onDraw({
      x: clamp(bounds.x, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE),
      y: clamp(bounds.y, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE),
      width: clamp(bounds.width, MIN_REGION_SIZE, MAX_REGION_SIZE),
      height: clamp(bounds.height, MIN_REGION_SIZE, MAX_REGION_SIZE),
    });
  }

  return (
    <div className="topology-region-drawing" tabIndex={0} ref={surface}
      aria-label="拖拽绘制区域，或按 Enter 添加默认区域"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY } };
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const box = event.currentTarget.getBoundingClientRect();
        const rect = rectangle(drag.current.start, { x: event.clientX, y: event.clientY });
        setPreview({ ...rect, x: rect.x - box.left, y: rect.y - box.top });
      }}
      onPointerUp={event => {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        drag.current = null;
        setPreview(null);
        const end = { x: event.clientX, y: event.clientY };
        const screen = rectangle(gesture.start, end);
        if (screen.width < 12 || screen.height < 12) return;
        commit(rectangle(toFlow(gesture.start), toFlow(end)));
      }}
      onPointerCancel={() => { drag.current = null; setPreview(null); }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') { onCancel(); return; }
        const box = event.currentTarget.getBoundingClientRect();
        const center = toFlow({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        commit({ x: center.x - 120, y: center.y - 72, width: 240, height: 144 });
      }}>
      <span className="topology-region-drawing-hint" role="status">在画布上拖拽绘制区域 · Esc 取消</span>
      {preview && <div className="topology-region-drawing-preview" aria-hidden="true"
        style={{ left: preview.x, top: preview.y, width: preview.width, height: preview.height }} />}
    </div>
  );
}
