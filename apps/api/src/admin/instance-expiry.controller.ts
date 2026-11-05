import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { InstanceExpiryService } from './instance-expiry.service';
import { InstancePowerService } from './instance-power.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/instance-expiry')
@UseGuards(AdminAuthGuard)
export class InstanceExpiryController {
  constructor(private readonly expiry: InstanceExpiryService, private readonly power: InstancePowerService,
    private readonly operations: OperationControlService) {}

  @Get(':kind/:id')
  list(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string) {
    return this.expiry.list(this.power.validateTarget(kind, id), request.adminUser);
  }

  @Get(':kind/:id/preview')
  preview(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string, @Query('expiresAt') at: string) {
    return this.expiry.preview(this.power.validateTarget(kind, id), request.adminUser, this.expiry.validateTime(at));
  }

  @Post(':kind/:id')
  submit(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!body || Object.keys(body).some(key => !['expiresAt', 'planDigest'].includes(key))
      || typeof body.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.planDigest)) throw new BadRequestException('必须提交新回收时间及原预览摘要。');
    const target = this.power.validateTarget(kind, id), at = this.expiry.validateTime(body.expiresAt, false), digest = body.planDigest;
    return this.operations.executeConfirmed({ context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'instance_expiry_' + kind, arguments: { target, expiresAt: at, planDigest: digest },
      targetType: 'instance_expiry', targetId: kind + ':' + id,
      resolveConfirmation: async () => {
        const preview = await this.expiry.preview(target, request.adminUser, at);
        if (preview.planDigest !== digest) throw new BadRequestException('预览已变化，请重新核对实例与回收时间。');
        return { targetId: kind + ':' + id, targetSnapshot: preview, summary: { target, expiresAt: at, planDigest: digest,
          instances: preview.plans.map(plan => ({ id: plan.instanceId, name: plan.instanceName, previousExpiresAt: plan.expiresAt })) } };
      }, execute: () => this.expiry.submit(target, request.adminUser, at, digest) });
  }

  @Post(':kind/:id/jobs/:jobId/verify')
  verify(@Req() request: AuthenticatedPlatformRequest, @Param('kind') kind: string, @Param('id') id: string, @Param('jobId') jobId: string) {
    return this.expiry.verify(this.power.validateTarget(kind, id), request.adminUser, jobId);
  }
}
