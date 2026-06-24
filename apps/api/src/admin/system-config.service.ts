import { Injectable } from '@nestjs/common';

@Injectable()
export class SystemConfigService {
  getSnapshot() {
    return {
      region: process.env.ALICLOUD_REGION ?? 'unset',
      zoneId: process.env.ALICLOUD_ZONE_ID ?? 'unset',
      provisionerMode: process.env.RANGE_PROVISIONER_MODE ?? 'unset',
      instanceTypeStrategy: process.env.OPENTOFU_INSTANCE_TYPE ?? process.env.ALICLOUD_INSTANCE_TYPE ?? 'unset',
      instanceTypePreferences: (process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES ??
        process.env.ALICLOUD_INSTANCE_TYPE_PREFERENCES ??
        '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
}
