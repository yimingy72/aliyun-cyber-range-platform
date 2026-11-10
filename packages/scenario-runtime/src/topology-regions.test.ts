import { describe, expect, it } from 'vitest';
import { readTopologyRegions, topologyRegionFields, type ManualTopologyRegion } from './topology-regions';

const region: ManualTopologyRegion = {
  kind: 'manual', id: 'area-1', title: '演示区域', x: -40, y: 70,
  width: 210, height: 160, color: '#1f5fbf', borderStyle: 'dashed', fill: 'tint',
};

describe('visual topology regions', () => {
  it('accepts bounded shapes, strips extra properties and rejects invalid styles and geometry', () => {
    expect(readTopologyRegions([
      { ...region, color: '#1F5FBF', extra: 'ignored' },
      { ...region, id: 'unsafe', color: 'url(example)' },
      { ...region, id: 'invalid-width', width: Infinity },
      { ...region, id: 'duplicate-test', x: 1e7 },
      { ...region, title: 'duplicate' },
      { kind: 'network', id: 'zone/switch', title: '教学网段', color: '#123456', fill: 'none', borderStyle: 'solid', x: 10 },
    ])).toEqual([
      region,
      { kind: 'network', id: 'zone/switch', title: '教学网段', color: '#123456', fill: 'none', borderStyle: 'solid' },
    ]);
    expect(topologyRegionFields([])).toEqual({});
  });
});
