import { BadRequestException, Body, ConflictException, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { ResourceAlertsService } from './resource-alerts.service';
import { ReclaimResourceAlertDto, ResourceAlertsQueryDto, SetResourcePatrolManagerDto } from './dto/resource-alerts.dto';

@Controller('admin/resource-alerts')
@UseGuards(AdminAuthGuard)
export class ResourceAlertsController {
  constructor(private readonly alerts: ResourceAlertsService, private readonly operations: OperationControlService) {}

  @Get()
  list(@Req() request: AuthenticatedPlatformRequest, @Query() query: ResourceAlertsQueryDto) {
    return this.alerts.list(request.adminUser, query);
  }

  @Get('patrol')
  patrol(@Req() request: AuthenticatedPlatformRequest) { return this.alerts.getPatrol(request.adminUser); }

  @Post('patrol')
  async setPatrol(@Req() request: AuthenticatedPlatformRequest, @Body() input: SetResourcePatrolManagerDto = {}) {
    const metadata = readOperationRequestMetadata(request);
    const result = await this.alerts.setPatrolManager(request.adminUser, input);
    await this.operations.audit({ requestId: metadata.requestId, operationId: metadata.requestId,
      actorUserId: request.adminUser.id, source: request.authContext.source, oauthClientId: request.authContext.oauthClientId,
      toolName: 'resource_patrol_manager_set', targetType: 'resource_patrol', targetId: result.managerUserId,
      sanitizedInput: { managerUserId: result.managerUserId }, phase: 'succeeded' });
    return result;
  }

  @Get(':id/preview')
  preview(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    return this.alerts.preview(request.adminUser, id);
  }

  @Post(':id/reclaim')
  reclaim(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string, @Body() input: ReclaimResourceAlertDto) {
    const metadata = readOperationRequestMetadata(request);
    if (!metadata.idempotencyKey) throw new BadRequestException('资源回收必须提供稳定幂等键。');
    // Web and MCP both require a server confirmation tied to this exact preview.
    return this.operations.executeConfirmed({ context: request.authContext, metadata,
      toolName: 'resource_alert_reclaim', arguments: { alertId: id, planDigest: input.planDigest },
      targetType: 'cloud_resource_alert', targetId: id,
      resolveConfirmation: async () => {
        const preview = await this.alerts.preview(request.adminUser, id);
        if (!preview.reclaimable || preview.planDigest !== input.planDigest) throw new ConflictException(preview.reason ?? '回收清单已变化，请重新预览。');
        return { targetId: id, targetSnapshot: { ...preview }, summary: { ...preview } };
      },
      execute: async () => this.alerts.reclaim(request.adminUser, id,
        { planDigest: input.planDigest, idempotencyKey: metadata.idempotencyKey! }),
    });
  }
}
