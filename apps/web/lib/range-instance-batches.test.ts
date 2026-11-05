import { describe, expect, it } from 'vitest';
import { groupRangeInstances, rangeBatchBusy, rangeBatchStatus } from './range-instance-batches';
import type { RangeInstance } from './admin-types';

const members: RangeInstance[] = [2, 1].map(index => ({ id: `range-${index}`, name: `靶场-${index}`, status: 'running',
  launchBatch: { id: 'batch-a', name: '靶场', index, quantity: 2 } }));
describe('range batch display groups', () => {
  it('keeps every batch intact and sorts members by their launch index', () => {
    const groups = groupRangeInstances([...members, { ...members[0], id: 'other', launchBatch: { ...members[0].launchBatch!, id: 'batch-b' } },
      { id: 'single', name: '靶场-3', status: 'running' }]);
    expect(groups).toHaveLength(3);
    expect(groups[0].instances.map(instance => instance.id)).toEqual(['range-1', 'range-2']);
    expect(groups[2].isBatch).toBe(false);
  });
  it('matches a child name but retains the full batch action scope', () => {
    const groups = groupRangeInstances(members, '  靶场-2 ');
    expect(groups).toHaveLength(1);
    expect(groups[0].instances).toHaveLength(2);
    expect(groupRangeInstances(members, '不存在')).toEqual([]);
  });
  it('summarizes real member states and blocks closure during create/update', () => {
    expect(rangeBatchStatus([{ ...members[0], status: 'destroy_failed' }, members[1]])).toBe('1 销毁失败 / 1 运行中');
    expect(rangeBatchBusy(members)).toBe(false);
    for (const status of ['pending_create', 'creating', 'pending_update', 'updating']) expect(rangeBatchBusy([{ ...members[0], status }])).toBe(true);
  });
});
