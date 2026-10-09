import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CloudAccountContextsService } from './cloud-account-contexts.service';
import { SaveCloudAccountContextDto } from './dto/cloud-account-context.dto';
import { SystemConfigService } from './system-config.service';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/cloud-contexts')
@UseGuards(AdminAuthGuard)
export class CloudAccountContextsController {
  constructor(
    private readonly cloudAccountContextsService: CloudAccountContextsService,
    private readonly systemConfigService: SystemConfigService,
    private readonly operationControl: OperationControlService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedPlatformRequest, @Query('includeInactive') includeInactive?: string) {
    if (includeInactive !== undefined && !['true', 'false'].includes(includeInactive)) {
      throw new BadRequestException('includeInactive 必须为 true 或 false。');
    }
    if (includeInactive === 'true' && request.adminUser?.role !== 'admin') {
      throw new ForbiddenException('仅管理员可查看未启用的云账号。');
    }
    return this.cloudAccountContextsService.list({ includeInactive: includeInactive === 'true' });
  }

  @Post()
  async save(@Req() request: AuthenticatedPlatformRequest, @Body() payload: SaveCloudAccountContextDto) {
    if (request.adminUser.role !== 'admin') throw new ForbiddenException('仅管理员可保存云账号。');
    const metadata = readOperationRequestMetadata(request);
    const execute = () => this.cloudAccountContextsService.saveTencentCloudContext(payload);
    if (request.authContext.source === 'mcp') {
      return this.operationControl.executeConfirmed({
        context: request.authContext, metadata, toolName: 'tencent_cloud_account_save', arguments: { ...payload },
        targetType: 'cloud_account_context',
        resolveConfirmation: async () => ({
          targetId: null, targetSnapshot: { provider: 'tencent_cloud', regionId: payload.regionId, zoneId: payload.zoneId },
          summary: { targetName: '腾讯云账号', regionId: payload.regionId, zoneId: payload.zoneId, activatesResourceCreation: false },
        }),
        execute: async () => ({ result: await execute() }),
      });
    }
    const audit = { requestId: metadata.requestId, operationId: metadata.requestId, actorUserId: request.adminUser.id,
      source: request.authContext.source, oauthClientId: request.authContext.oauthClientId, toolName: 'tencent_cloud_account_save', targetType: 'cloud_account_context', sanitizedInput: { ...payload } };
    await this.operationControl.audit({ ...audit, phase: 'requested' });
    try {
      const result = await execute();
      await this.operationControl.audit({ ...audit, phase: 'succeeded', targetId: result.id });
      return result;
    } catch (error) {
      await this.operationControl.audit({ ...audit, phase: 'failed', errorCode: 'TENCENT_ACCOUNT_SAVE_FAILED' });
      throw error;
    }
  }

  @Get(':id/instance-type-availability')
  async getInstanceTypeAvailability(@Param('id') id: string, @Query('cpu') cpuText?: string, @Query('memory') memoryText?: string) {
    const cpu = Number(cpuText);
    const memory = Number(memoryText);
    if (!cpuText || !memoryText || !/^\d+$/.test(cpuText) || !/^\d+$/.test(memoryText)
      || !Number.isSafeInteger(cpu) || cpu <= 0 || !Number.isSafeInteger(memory) || memory <= 0) {
      throw new BadRequestException('cpu 和 memory 必须是大于 0 的整数');
    }
    const context = await this.systemConfigService.getAccountContextById(id);
    return this.systemConfigService.getInstanceTypeAvailabilityInContext({ cpu, memory }, context);
  }
}
