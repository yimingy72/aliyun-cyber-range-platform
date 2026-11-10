export const MAX_TOPOLOGY_REGIONS = 100;
export const MIN_REGION_SIZE = 40;
export const MAX_REGION_SIZE = 12000;
export const MAX_REGION_COORDINATE = 100000;
export const REGION_BORDER_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const REGION_FILLS = ['none', 'tint'] as const;

export type TopologyRegionAppearance = {
  title: string;
  color: string;
  borderStyle: (typeof REGION_BORDER_STYLES)[number];
  fill: (typeof REGION_FILLS)[number];
};

export type TopologyRegionBounds = { x: number; y: number; width: number; height: number };
export type ManualTopologyRegion = TopologyRegionAppearance & TopologyRegionBounds & { kind: 'manual'; id: string };
export type TopologyRegion = ManualTopologyRegion | (TopologyRegionAppearance & { kind: 'network'; id: string });

export function readTopologyRegions(value: unknown): TopologyRegion[] {
  if (!Array.isArray(value)) return [];
  const result: TopologyRegion[] = [];
  const seen = new Set<string>();
  const bounded = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  for (const item of value.slice(0, MAX_TOPOLOGY_REGIONS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { kind, id, title, color, borderStyle, fill, x, y, width, height } = item as Record<string, unknown>;
    if ((kind !== 'manual' && kind !== 'network') || typeof id !== 'string' || !id.trim() || id.length > 180
      || typeof title !== 'string' || !title.trim() || title.length > 80
      || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)
      || (borderStyle !== 'solid' && borderStyle !== 'dashed' && borderStyle !== 'dotted')
      || (fill !== 'none' && fill !== 'tint')) continue;
    const key = kind + ':' + id;
    if (seen.has(key)) continue;
    const appearance = { id, title: title.trim(), color: color.toLowerCase(), borderStyle, fill } as const;
    if (kind === 'network') result.push({ ...appearance, kind });
    else {
      if (!bounded(x, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE)
        || !bounded(y, -MAX_REGION_COORDINATE, MAX_REGION_COORDINATE)
        || !bounded(width, MIN_REGION_SIZE, MAX_REGION_SIZE) || !bounded(height, MIN_REGION_SIZE, MAX_REGION_SIZE)) continue;
      result.push({ ...appearance, kind, x, y, width, height });
    }
    seen.add(key);
  }
  return result;
}

export function topologyRegionFields(value: unknown): { regions?: TopologyRegion[] } {
  const regions = readTopologyRegions(value);
  return regions.length ? { regions } : {};
}
