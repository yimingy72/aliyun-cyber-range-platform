import type { TopologySnapshot } from './topology-flow-types';

export type TopologyHistory = {
  past: TopologySnapshot[];
  present: TopologySnapshot;
  future: TopologySnapshot[];
};

export function createTopologyHistory(present: TopologySnapshot): TopologyHistory {
  return {
    past: [],
    present,
    future: [],
  };
}

export function pushTopologySnapshot(history: TopologyHistory, next: TopologySnapshot): TopologyHistory {
  return JSON.stringify(history.present) === JSON.stringify(next)
    ? history
    : {
      past: [...history.past, history.present],
      present: next,
      future: [],
    };
}

export function undoTopology(history: TopologyHistory): TopologyHistory {
  const previous = history.past.at(-1);

  return previous
    ? {
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present, ...history.future],
    }
    : history;
}

export function redoTopology(history: TopologyHistory): TopologyHistory {
  const next = history.future[0];

  return next
    ? {
      past: [...history.past, history.present],
      present: next,
      future: history.future.slice(1),
    }
    : history;
}
