import type { TopologySnapshot } from './topology-flow-types';

export type TopologyHistory = {
  past: TopologySnapshot[];
  present: TopologySnapshot;
  future: TopologySnapshot[];
};

function cloneTopologySnapshot(snapshot: TopologySnapshot): TopologySnapshot {
  return structuredClone(snapshot);
}

function cloneTopologySnapshots(snapshots: TopologySnapshot[]): TopologySnapshot[] {
  return snapshots.map(cloneTopologySnapshot);
}

export function createTopologyHistory(present: TopologySnapshot): TopologyHistory {
  return {
    past: [],
    present: cloneTopologySnapshot(present),
    future: [],
  };
}

export function pushTopologySnapshot(history: TopologyHistory, next: TopologySnapshot): TopologyHistory {
  return JSON.stringify(history.present) === JSON.stringify(next)
    ? history
    : {
      past: [...cloneTopologySnapshots(history.past), cloneTopologySnapshot(history.present)],
      present: cloneTopologySnapshot(next),
      future: [],
    };
}

export function undoTopology(history: TopologyHistory): TopologyHistory {
  const previous = history.past.at(-1);

  return previous
    ? {
      past: cloneTopologySnapshots(history.past.slice(0, -1)),
      present: cloneTopologySnapshot(previous),
      future: [cloneTopologySnapshot(history.present), ...cloneTopologySnapshots(history.future)],
    }
    : history;
}

export function redoTopology(history: TopologyHistory): TopologyHistory {
  const next = history.future[0];

  return next
    ? {
      past: [...cloneTopologySnapshots(history.past), cloneTopologySnapshot(history.present)],
      present: cloneTopologySnapshot(next),
      future: cloneTopologySnapshots(history.future.slice(1)),
    }
    : history;
}
