import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { InstancePowerService } from './instance-power.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/instance-power')
@UseGuards(AdminAuthGuard)
export class InstancePowerController {
  constructor(private readonly power: InstancePowerService, private readonly operations: OperationControlService) {}

  @Get(':kind/:id')
  list(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string) {
    return this.power.list(this.power.validateTarget(kind, id), request.adminUser);
  }

  @Get(':kind/:id/preview')
  preview(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string,
    @Query('action') action: string, @Query('scheduledAt') scheduledAt?: string) {
    this.power.validateAction(action);
    return this.power.preview(this.power.validateTarget(kind, id), action, request.adminUser, scheduledAt);
  }

  @Post(':kind/:id')
  submit(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!body || Object.keys(body).some(key => !['action', 'planDigest', 'scheduledAt'].includes(key))
      || typeof body.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.planDigest)
      || body.scheduledAt !== undefined && typeof body.scheduledAt !== 'string') throw new BadRequestException('必须提交原预览摘要、明确动作和可选带时区预约时间。');
    this.power.validateAction(body.action);
    const target = this.power.validateTarget(kind, id), action = body.action, digest = body.planDigest, at = body.scheduledAt as string | undefined;
    return this.operations.executeConfirmed({ context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'instance_power_' + kind + '_' + action, arguments: { target, action, planDigest: digest, ...(at ? { scheduledAt: at } : {}) },
      targetType: 'instance_power', targetId: kind + ':' + id,
      resolveConfirmation: async () => {
        const preview = await this.power.preview(target, action, request.adminUser, at);
        if (preview.planDigest !== digest) throw new BadRequestException('预览已变化，请重新核对目标和时间。');
        return { targetId: kind + ':' + id, targetSnapshot: preview, summary: { action, scheduledAt: at ?? null,
          instances: preview.plans.map(plan => ({ id: plan.instanceId, name: plan.instanceName, hostCount: plan.hosts.length })), warnings: preview.warnings } };
      }, execute: () => this.power.submit(target, action, request.adminUser, digest, at) });
  }

  @Post(':kind/:id/cancel')
  cancel(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string,
    @Body() body: { schedules: Array<{ instanceId: string; scheduleId: string; revision: number }> }) {
    if (!body || Object.keys(body).some(key => key !== 'schedules') || !Array.isArray(body.schedules)
      || body.schedules.some(row => !row || Object.keys(row).some(key => !['instanceId', 'scheduleId', 'revision'].includes(key))
        || typeof row.instanceId !== 'string' || typeof row.scheduleId !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1)) throw new BadRequestException('取消预约需准确预约 ID 和版本。');
    const target = this.power.validateTarget(kind, id);
    return this.operations.executeIdempotent({ context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'instance_power_cancel', arguments: { target, schedules: body.schedules }, targetType: 'instance_power',
      execute: () => this.power.cancel(target, request.adminUser, body.schedules) });
  }

  @Post(':kind/:id/jobs/:jobId/verify')
  verify(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string, @Param('jobId') jobId: string) {
    return this.power.reconcile(this.power.validateTarget(kind, id), request.adminUser, jobId);
  }
}
