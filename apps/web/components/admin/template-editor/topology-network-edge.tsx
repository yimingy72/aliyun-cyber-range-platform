'use client';
import React from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { TopologyFlowEdge } from './topology-flow-types';
import { roundedRoutePath } from './topology-edge-routing';

export function TopologyNetworkEdge(props: EdgeProps<TopologyFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, data, id } = props;
  const route = data?.route, first = route?.[0], last = route?.[route.length - 1];
  // During dragging, live handles take precedence until the persisted geometry catches up.
  const matches = first && last && Math.abs(first.x - sourceX) + Math.abs(first.y - sourceY) < 2
    && Math.abs(last.x - targetX) + Math.abs(last.y - targetY) < 2;
  const path = matches ? roundedRoutePath(route!) : getSmoothStepPath({ ...props, borderRadius: 8 })[0];
  return <g data-obstacle-routed={matches ? 'true' : 'false'}><title>{data?.description}</title><BaseEdge id={id} path={path} interactionWidth={24}
    style={{ '--network-edge-color': data?.color } as React.CSSProperties} /></g>;
}
