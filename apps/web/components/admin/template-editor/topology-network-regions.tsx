'use client';

import React from 'react';
import { ViewportPortal, type XYPosition } from '@xyflow/react';
import {
  MAX_REGION_COORDINATE, MAX_REGION_SIZE, MIN_REGION_SIZE,
  type TopologyRegion, type TopologyRegionAppearance, type TopologyRegionBounds,
} from '@aliyun-cyber-range/scenario-runtime';

import type { TemplateNode } from '../../../lib/scenario-graph';
import type { TemplateEdge } from './template-editor-screen';
import { readNetworkRegions } from './topology-network-model';

export type CanvasRegion = TopologyRegionAppearance & TopologyRegionBounds & {
  kind: TopologyRegion['kind'];
  id: string;
  description: string;
  styled: boolean;
};

export const regionKey = ({ kind, id }: Pick<TopologyRegion, 'kind' | 'id'>) => kind + ':' + id;

export function buildCanvasRegions(nodes: TemplateNode[], edges: TemplateEdge[], regions: TopologyRegion[]): CanvasRegion[] {
  const styles = new Map(regions.filter(region => region.kind === 'network').map(region => [region.id, region]));
  return [
    ...regions.flatMap(region => region.kind === 'manual' ? [{ ...region, description: '画布标注', styled: true }] : []),
    ...readNetworkRegions(nodes, edges).map((region): CanvasRegion => ({
      ...region, kind: 'network', borderStyle: 'solid', fill: 'tint', ...styles.get(region.id), styled: styles.has(region.id),
    })),
  ];
}

type RegionDrag = {
  pointerId: number;
  region: CanvasRegion;
  origin: XYPosition;
  resize: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

export function TopologyNetworkRegions({
  regions, selectedKey, canEdit, toFlow, onSelect, onBoundsChange,
}: {
  regions: CanvasRegion[];
  selectedKey: string | null;
  canEdit: boolean;
  toFlow: (position: XYPosition) => XYPosition;
  onSelect: (region: CanvasRegion) => void;
  onBoundsChange: (region: CanvasRegion, bounds: TopologyRegionBounds) => void;
}) {
  const drag = React.useRef<RegionDrag | null>(null);
  const [preview, setPreview] = React.useState<{ key: string; bounds: TopologyRegionBounds } | null>(null);

  function start(event: React.PointerEvent<HTMLButtonElement>, region: CanvasRegion, resize: boolean) {
    if (event.button !== 0 || region.kind !== 'manual' || !canEdit) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(region);
    drag.current = { pointerId: event.pointerId, region, origin: toFlow({ x: event.clientX, y: event.clientY }), resize };
  }

  function readBounds(event: React.PointerEvent, gesture: RegionDrag): TopologyRegionBounds {
    const { region, origin, resize } = gesture;
    const point = toFlow({ x: event.clientX, y: event.clientY });
    const dx = point.x - origin.x, dy = point.y - origin.y;
    return resize ? {
      x: region.x, y: region.y,
      width: clamp(region.width + dx, MIN_REGION_SIZE, MAX_REGION_SIZE),
      height: clamp(region.height + dy, MIN_REGION_SIZE, MAX_REGION_SIZE),
    } : {
      x: clamp(region.x + dx, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE),
      y: clamp(region.y + dy, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE),
      width: region.width, height: region.height,
    };
  }

  function move(event: React.PointerEvent) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreview({ key: regionKey(gesture.region), bounds: readBounds(event, gesture) });
  }

  function finish(event: React.PointerEvent, cancel = false) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
    if (cancel || !canEdit) return;
    const bounds = readBounds(event, gesture);
    const before = gesture.region;
    if (bounds.x !== before.x || bounds.y !== before.y || bounds.width !== before.width || bounds.height !== before.height)
      onBoundsChange(before, bounds);
  }

  return (
    <ViewportPortal>
      <div className="topology-network-regions" aria-label="画布区域">
        {regions.map(region => {
          const key = regionKey(region);
          const selected = selectedKey === key;
          const bounds = preview?.key === key ? preview.bounds : region;
          const style = {
            left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height,
            '--topology-region-color': region.color,
            ...(region.styled ? { borderColor: region.color, borderStyle: region.borderStyle } : {}),
          } as React.CSSProperties;
          return (
            <section key={key} className="topology-network-region" data-region-id={region.id}
              data-region-kind={region.kind} data-region-styled={region.styled} data-region-fill={region.fill}
              data-selected={selected} aria-label={region.title + '，' + region.description} style={style}>
              <header>
                <button type="button" className="topology-region-title nodrag nopan" aria-pressed={selected}
                  aria-label={region.title + '，查看区域属性'} data-movable={canEdit && region.kind === 'manual'}
                  onClick={(event) => { event.stopPropagation(); onSelect(region); }}
                  onPointerDown={(event) => start(event, region, false)} onPointerMove={move}
                  onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}>
                  <i aria-hidden="true" style={{ backgroundColor: region.color }} />
                  <strong title={region.title}>{region.title}</strong><span>{region.description}</span>
                </button>
              </header>
              {selected && canEdit && region.kind === 'manual' && (
                <button type="button" className="topology-region-resize nodrag nopan"
                  aria-label="拖动调整区域大小" title="拖动调整区域大小" tabIndex={-1}
                  onPointerDown={(event) => start(event, region, true)} onPointerMove={move}
                  onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} />
              )}
            </section>
          );
        })}
      </div>
    </ViewportPortal>
  );
}
