import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import {
  maskSystemCloudConfig,
  SystemConfigService,
} from './system-config.service';
import { UpdateSystemCloudConfigDto } from './dto/system-cloud-config.dto';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';
import { assertAlibabaCloudFeature } from '../auth/cloud-provider-policy';

@Controller('admin/system-config')
@UseGuards(AdminAuthGuard)
export class SystemConfigController {
  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  async getSnapshot() {
    return this.systemConfigService.getDisplaySnapshot();
  }

  @Get('instance-type-availability')
  async getInstanceTypeAvailability(@Query('cpu') cpuText?: string, @Query('memory') memoryText?: string) {
    const cpu = Number.parseInt(cpuText ?? '', 10);
    const memory = Number.parseInt(memoryText ?? '', 10);

    if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) {
      throw new BadRequestException('cpu 和 memory 必须是大于 0 的整数');
    }

    return this.systemConfigService.getInstanceTypeAvailability({
      cpu,
      memory,
    });
  }

  @Patch()
  async updateSnapshot(@Req() request: AuthenticatedPlatformRequest, @Body() payload: UpdateSystemCloudConfigDto) {
    assertAlibabaCloudFeature('legacyCloudConfig');
    if (!request.adminUser.isPlatformManager) throw new ForbiddenException('仅平台超管可更新云账号配置。');
    if (!payload || Array.isArray(payload)
      || (payload.defaultRegion === undefined && payload.defaultZoneId === undefined
        && payload.accessKeyId === undefined && payload.accessKeySecret === undefined
        && payload.imageImportBucket === undefined)) {
      throw new BadRequestException('至少提供一个需要更新的云配置字段。');
    }
    if (request.authContext.source !== 'mcp') {
      return maskSystemCloudConfig(await this.systemConfigService.updateSnapshot(payload));
    }
    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata,
      toolName: 'cloud_config_update',
      arguments: { ...payload },
      targetType: 'system_cloud_config',
      targetId: 'default',
      resolveConfirmation: async () => ({
        targetId: 'default',
        targetSnapshot: { id: 'default' },
        summary: { targetName: 'cloud-config', destructive: true },
      }),
      execute: async () => ({ result: maskSystemCloudConfig(await this.systemConfigService.updateSnapshot(payload)) }),
    });
  }
}
