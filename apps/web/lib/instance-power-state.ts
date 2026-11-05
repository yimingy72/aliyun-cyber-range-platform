import type { RangeInstance } from './admin-types';

export const POWER_STATUS_LABELS: Record<string, string> = {
  economical_stopped: '节省停机', power_stopping: '节省停机中', power_starting: '恢复开机中',
  power_stopped_standard: '普通停机（未节省）', power_partial: '电源状态部分完成', power_unknown: '电源结果待核验',
};
export function instancePowerStatus(instance: RangeInstance) {
  const power = instance.powerControl;
  if (instance.status !== 'running' || !power) return instance.status;
  if (power.phase) return power.phase === 'stopping' ? 'power_stopping' : 'power_starting';
  return ({ economical_stopped: 'economical_stopped', stopped_standard: 'power_stopped_standard', partial: 'power_partial', unknown: 'power_unknown', running: 'running' })[power.state];
}
