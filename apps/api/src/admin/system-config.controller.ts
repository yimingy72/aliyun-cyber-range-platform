import { BadRequestException, Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import {
  maskSystemCloudConfig,
  SystemConfigService,
  type SystemCloudConfig,
} from './system-config.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/system-config')
@UseGuards(AdminAuthGuard)
export class SystemConfigController {
  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  async getSnapshot() {
    return maskSystemCloudConfig(await this.systemConfigService.getSnapshot());
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
  async updateSnapshot(@Req() request: AuthenticatedPlatformRequest, @Body() payload: Partial<SystemCloudConfig>) {
    if (request.authContext.source !== 'mcp') {
      return maskSystemCloudConfig(await this.systemConfigService.updateSnapshot(payload));
    }
    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? 'cloud-config-update' },
      toolName: 'cloud_config_update',
      arguments: payload as Record<string, unknown>,
      targetType: 'system_cloud_config',
      targetId: 'default',
      resolveConfirmation: async () => ({
        targetId: 'default',
        targetSnapshot: { id: 'default' },
        summary: { targetName: 'cloud-config', destructive: false },
      }),
      execute: async () => ({ result: maskSystemCloudConfig(await this.systemConfigService.updateSnapshot(payload)) }),
    });
  }
}
