import { Injectable } from '@nestjs/common';

type CloudConfigCheck = {
  key: string;
  label: string;
  configured: boolean;
  required: boolean;
};

function normalizeOptionalEnvValue(value: string | null | undefined) {
  const normalized = value?.trim();

  return normalized ? normalized : null;
}

@Injectable()
export class SystemConfigService {
  getSnapshot() {
    const region = process.env.ALICLOUD_REGION ?? 'unset';
    const zoneId = process.env.ALICLOUD_ZONE_ID ?? 'unset';
    const provisionerMode = process.env.RANGE_PROVISIONER_MODE ?? 'unset';
    const instanceTypeStrategy =
      process.env.OPENTOFU_INSTANCE_TYPE ?? process.env.ALICLOUD_INSTANCE_TYPE ?? 'unset';
    const instanceTypePreferences = (process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES ??
      process.env.ALICLOUD_INSTANCE_TYPE_PREFERENCES ??
      '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const imageId =
      normalizeOptionalEnvValue(process.env.OPENTOFU_IMAGE_ID) ??
      normalizeOptionalEnvValue(process.env.ALICLOUD_IMAGE_ID) ??
      'unset';
    const instancePasswordConfigured = Boolean(
      normalizeOptionalEnvValue(process.env.OPENTOFU_INSTANCE_PASSWORD),
    );
    const providerZipPathConfigured = Boolean(
      normalizeOptionalEnvValue(process.env.ALICLOUD_PROVIDER_ZIP_PATH),
    );
    const checks: CloudConfigCheck[] = [
      {
        key: 'access_key',
        label: 'AccessKey',
        configured: Boolean(normalizeOptionalEnvValue(process.env.ALICLOUD_ACCESS_KEY)),
        required: true,
      },
      {
        key: 'secret_key',
        label: 'AccessKey Secret',
        configured: Boolean(normalizeOptionalEnvValue(process.env.ALICLOUD_SECRET_KEY)),
        required: true,
      },
      {
        key: 'region',
        label: '默认地域',
        configured: region !== 'unset',
        required: true,
      },
      {
        key: 'zone_id',
        label: '默认可用区',
        configured: zoneId !== 'unset',
        required: true,
      },
      {
        key: 'image_id',
        label: '镜像 ID',
        configured: imageId !== 'unset',
        required: true,
      },
      {
        key: 'instance_password',
        label: '实例密码',
        configured: instancePasswordConfigured,
        required: true,
      },
      {
        key: 'provider_zip_path',
        label: 'Provider 离线包',
        configured: providerZipPathConfigured,
        required: false,
      },
    ];

    return {
      region,
      zoneId,
      provisionerMode,
      instanceTypeStrategy,
      instanceTypePreferences,
      imageId,
      instancePasswordConfigured,
      providerZipPathConfigured,
      readyForPlan: checks.filter((item) => item.required).every((item) => item.configured),
      checks,
    };
  }
}
