import type { InstanceOwnerFilter } from '../../../lib/admin-types';
import { AdminSelectField } from './admin-select-field';

const options = [
  { value: 'mine', label: '仅本人' },
  { value: 'all', label: '全部用户' },
] as const;

export function InstanceOwnerSelect({ owner, onChange }: { owner: InstanceOwnerFilter; onChange: (owner: InstanceOwnerFilter) => void }) {
  return <AdminSelectField ariaLabel="实例归属" className="w-full sm:w-28" options={options} value={owner}
    onValueChange={value => onChange(value === 'all' ? 'all' : 'mine')} />;
}
