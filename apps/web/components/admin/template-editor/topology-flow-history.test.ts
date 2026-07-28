import { describe, expect, it } from 'vitest';

import {
  createTopologyHistory,
  pushTopologySnapshot,
  redoTopology,
  undoTopology,
} from './topology-flow-history';
import type { TopologySnapshot } from './topology-flow-types';

const first: TopologySnapshot = {
  nodes: [{
    id: 'router-1',
    kind: 'router',
    label: '主路由器',
    routeRole: 'core',
    egressType: 'internet',
    bindEip: true,
  }],
  edges: [],
  viewport: null,
};

const second: TopologySnapshot = {
  ...first,
  nodes: [{
    ...first.nodes[0],
    position: { x: 120, y: 80 },
  }],
};

const third: TopologySnapshot = {
  ...first,
  nodes: [{
    ...first.nodes[0],
    position: { x: 280, y: 160 },
  }],
};

describe('topology flow history', () => {
  it('记录完成动作，支持撤销和重做，并在新动作后清空重做分支', () => {
    const initial = createTopologyHistory(first);
    const moved = pushTopologySnapshot(initial, second);
    const undone = undoTopology(moved);
    const redone = redoTopology(undone);
    const branched = pushTopologySnapshot(undone, third);

    expect(moved).toEqual({
      past: [first],
      present: second,
      future: [],
    });
    expect(undone).toEqual({
      past: [],
      present: first,
      future: [second],
    });
    expect(redone).toEqual({
      past: [first],
      present: second,
      future: [],
    });
    expect(branched).toEqual({
      past: [first],
      present: third,
      future: [],
    });
  });
});
