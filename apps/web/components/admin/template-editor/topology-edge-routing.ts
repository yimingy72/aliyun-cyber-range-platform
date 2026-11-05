export type RoutePoint = { x: number; y: number };
export type PortSide = 'top' | 'right' | 'bottom' | 'left';
export type RouteBox = RoutePoint & { id: string; width: number; height: number };
export type RouteConnection = { id: string; source: RoutePoint; target: RoutePoint; sourceSide: PortSide; targetSide: PortSide };
const distance = (a: RoutePoint, b: RoutePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function segmentHitsBox(a: RoutePoint, b: RoutePoint, box: RouteBox, margin = 0) {
  const left = box.x - margin, right = box.x + box.width + margin, top = box.y - margin, bottom = box.y + box.height + margin;
  return a.x === b.x ? a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom
    : a.y === b.y && a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
}

function crossing(a: RoutePoint, b: RoutePoint, c: RoutePoint, d: RoutePoint) {
  if (a.x === b.x && c.y === d.y) return a.x > Math.min(c.x, d.x) && a.x < Math.max(c.x, d.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y);
  if (a.y === b.y && c.x === d.x) return c.x > Math.min(a.x, b.x) && c.x < Math.max(a.x, b.x) && a.y >= Math.min(c.y, d.y) && a.y <= Math.max(c.y, d.y);
  if (a.x === b.x && c.x === d.x && a.x === c.x) return Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) > Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
  if (a.y === b.y && c.y === d.y && a.y === c.y) return Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
  return false;
}

const stub = (point: RoutePoint, side: PortSide): RoutePoint => ({
  x: point.x + (side === 'right' ? 20 : side === 'left' ? -20 : 0),
  y: point.y + (side === 'bottom' ? 20 : side === 'top' ? -20 : 0),
});

type SearchEntry = { key: number; cost: number; priority: number };
// The routing grid is sparse in practice; a heap keeps large topologies off the quadratic queue path.
class SearchQueue {
  private items: SearchEntry[] = [];
  push(entry: SearchEntry) {
    let index = this.items.length; this.items.push(entry);
    while (index > 0) { const parent = (index - 1) >> 1; if (this.items[parent]!.priority <= entry.priority) break; this.items[index] = this.items[parent]!; index = parent; }
    this.items[index] = entry;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1]!.priority < this.items[child]!.priority) child++;
        if (last.priority <= this.items[child]!.priority) break;
        this.items[index] = this.items[child]!; index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function simplify(points: RoutePoint[]) {
  const result: RoutePoint[] = [];
  for (const point of points) {
    if (result.length && distance(result[result.length - 1]!, point) === 0) continue;
    while (result.length > 1) {
      const a = result[result.length - 2]!, b = result[result.length - 1]!;
      if (!(a.x === b.x && b.x === point.x || a.y === b.y && b.y === point.y)) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

/** Orthogonal, obstacle-aware routes; crossings are a soft cost, never a claim of planarity. */
export function routeTopologyConnections(boxes: RouteBox[], connections: RouteConnection[]) {
  const result = new Map<string, RoutePoint[]>();
  const routedSegments: Array<[RoutePoint, RoutePoint]> = [];
  const sorted = [...connections].sort((a, b) => distance(a.source, a.target) - distance(b.source, b.target) || a.id.localeCompare(b.id));
  const baseXs = boxes.flatMap(box => [box.x - 20, box.x + box.width + 20]);
  const baseYs = boxes.flatMap(box => [box.y - 20, box.y + box.height + 20]);
  for (const connection of sorted) {
    const start = stub(connection.source, connection.sourceSide), end = stub(connection.target, connection.targetSide);
    const inside = (point: RoutePoint) => boxes.some(box => point.x > box.x - 8 && point.x < box.x + box.width + 8 && point.y > box.y - 8 && point.y < box.y + box.height + 8);
    if (inside(start) || inside(end)) continue;
    const xs = [...new Set([...baseXs, start.x, end.x])].sort((a, b) => a - b);
    const ys = [...new Set([...baseYs, start.y, end.y])].sort((a, b) => a - b);
    const at = (key: number) => { const cell = Math.floor(key / 3); return { x: xs[cell % xs.length]!, y: ys[Math.floor(cell / xs.length)]! }; };
    const encode = (x: number, y: number, direction: number) => (y * xs.length + x) * 3 + direction;
    const startKey = encode(xs.indexOf(start.x), ys.indexOf(start.y), 0);
    const queue = new SearchQueue(), costs = new Map([[startKey, 0]]), parents = new Map<number, number>();
    queue.push({ key: startKey, cost: 0, priority: distance(start, end) });
    let found: number | undefined, explored = 0;
    while (explored++ < 20_000) {
      const current = queue.pop(); if (!current) break;
      if (current.cost !== costs.get(current.key)) continue;
      const point = at(current.key), cell = Math.floor(current.key / 3), x = cell % xs.length, y = Math.floor(cell / xs.length);
      if (distance(point, end) === 0) { found = current.key; break; }
      for (const [dx, dy, direction] of [[-1, 0, 1], [1, 0, 1], [0, -1, 2], [0, 1, 2]]) {
        const nx = x + dx!, ny = y + dy!;
        if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue;
        const next = { x: xs[nx]!, y: ys[ny]! };
        if (boxes.some(box => segmentHitsBox(point, next, box, 8))) continue;
        const crossings = routedSegments.filter(([a, b]) => crossing(point, next, a, b)).length;
        const cost = current.cost + distance(point, next) + (current.key % 3 && current.key % 3 !== direction ? 28 : 0) + crossings * 160;
        const key = encode(nx, ny, direction!);
        if (cost >= (costs.get(key) ?? Infinity)) continue;
        costs.set(key, cost); parents.set(key, current.key); queue.push({ key, cost, priority: cost + distance(next, end) });
      }
    }
    if (found === undefined) continue; // Overlapping manually placed nodes retain the library's safe live-edge fallback.
    const reverse: RoutePoint[] = [];
    for (let key: number | undefined = found; key !== undefined; key = parents.get(key)) reverse.push(at(key));
    const points = simplify([connection.source, ...reverse.reverse(), connection.target]);
    result.set(connection.id, points);
    points.slice(1).forEach((point, index) => routedSegments.push([points[index]!, point]));
  }
  return result;
}

export function roundedRoutePath(points: RoutePoint[], radius = 8) {
  if (!points.length) return '';
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const before = distance(a, b), after = distance(b, c), r = Math.min(radius, before / 2, after / 2);
    if (!before || !after) continue;
    path += ` L ${b.x + (a.x - b.x) * r / before} ${b.y + (a.y - b.y) * r / before} Q ${b.x} ${b.y} ${b.x + (c.x - b.x) * r / after} ${b.y + (c.y - b.y) * r / after}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${last.x} ${last.y}`;
}
