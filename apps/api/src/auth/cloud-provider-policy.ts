import { BadRequestException } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope } from './cloud-workspace-scope';

// These are Alibaba-specific platform integrations, not missing Tencent products.
// Call before confirmation/audit/job creation so web and MCP reject identically.
export function assertAlibabaCloudFeature(feature: 'ossBillingBinding' | 'mogongCatalog' | 'legacyCloudConfig') {
  const scope = getCurrentCloudWorkspaceScope();
  if (scope && !('system' in scope) && scope.provider !== 'alibaba_cloud') {
    throw new BadRequestException({ code: 'CLOUD_PROVIDER_UNSUPPORTED', provider: scope.provider, feature,
      message: feature === 'legacyCloudConfig'
        ? '腾讯云配置请使用云账号绑定入口，不能更新阿里云兼容配置。'
        : feature === 'ossBillingBinding'
          ? '腾讯云工作空间不支持阿里云 OSS 费用声明；腾讯云镜像导入使用专属 COS。'
          : '墨攻源目录绑定阿里云镜像，不能在腾讯云工作空间收录或复用云镜像 ID。' });
  }
}
