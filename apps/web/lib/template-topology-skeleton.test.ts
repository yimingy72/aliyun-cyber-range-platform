import { describe, expect, it } from 'vitest';

import {
  createEnterpriseRangeSkeleton,
  createEnterpriseRangeSkeletonEdges,
} from './template-topology-skeleton';

describe('createEnterpriseRangeSkeleton', () => {
  it('provides initial positions for the default router, switch, and ecs nodes', () => {
    expect(createEnterpriseRangeSkeleton()).toEqual([
      expect.objectContaining({
        id: 'router-core',
        position: { x: 120, y: 220 },
      }),
      expect.objectContaining({
        id: 'switch-core',
        position: { x: 360, y: 220 },
      }),
      expect.objectContaining({
        id: 'ecs-core-1',
        position: { x: 620, y: 220 },
      }),
    ]);
  });

  it('provides default router -> switch -> ecs relations for the initial topology', () => {
    expect(createEnterpriseRangeSkeletonEdges()).toEqual([
      {
        id: 'edge-router-core-switch-core',
        fromNodeId: 'router-core',
        toNodeId: 'switch-core',
        relationType: 'manual',
        label: '主路由器 -> 业务交换机',
      },
      {
        id: 'edge-switch-core-ecs-core-1',
        fromNodeId: 'switch-core',
        toNodeId: 'ecs-core-1',
        relationType: 'manual',
        label: '业务交换机 -> 业务 ECS',
      },
    ]);
  });
});
