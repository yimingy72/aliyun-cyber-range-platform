'use client';
import React from 'react';
import { ViewportPortal } from '@xyflow/react';
import type { TemplateNode } from '../../../lib/scenario-graph';
import type { TemplateEdge } from './template-editor-screen';
import { readNetworkRegions } from './topology-network-model';

export function TopologyNetworkRegions({ nodes, edges }: { nodes: TemplateNode[]; edges: TemplateEdge[] }) {
  const regions = readNetworkRegions(nodes, edges);
  return <ViewportPortal><div className="topology-network-regions" aria-label="网络区域分组">
    {regions.map(region => <section key={region.id} className="topology-network-region" data-region-id={region.id}
      aria-label={`${region.title}，${region.description}`} style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
      <header><i aria-hidden="true" style={{ backgroundColor: region.color }} /><strong>{region.title}</strong><span>{region.description}</span></header>
    </section>)}
  </div></ViewportPortal>;
}
