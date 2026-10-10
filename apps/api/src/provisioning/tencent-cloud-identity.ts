import { createHash } from 'node:crypto';
import type { RangeInstanceRecord } from '../admin/admin.repository';

export function buildTencentSingleCreationIntent(instance: RangeInstanceRecord, sourceJobId: string) {
  const config = instance.singleInstanceConfig;
  if (!config?.cloudAccountContextId || !config.cloudAccountUid || !config.regionId || !config.zoneId || !instance.singleInstanceBatchId || !sourceJobId)
    throw new Error('Tencent creation intent requires a frozen workspace/account/region/zone/batch/job');
  return createHash('sha256').update(JSON.stringify(['tencent_cloud', config.cloudAccountContextId, config.cloudAccountUid,
    config.regionId, config.zoneId, instance.singleInstanceBatchId, instance.id, sourceJobId])).digest('hex').slice(0, 32);
}
