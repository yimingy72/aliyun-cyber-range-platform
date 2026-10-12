import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AliyunOssManagedBucketService } from './aliyun-oss-managed-bucket.service';
import { requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import { BillingOssBindingService } from './billing-oss-binding.service';
import { BindBillingOssBucketDto, CreateBillingOssBucketDto } from './dto/billing-oss-binding.dto';

@Controller('admin/billing/oss-binding')
@UseGuards(AdminAuthGuard)
export class BillingOssBindingController {
  constructor(private readonly bindings: BillingOssBindingService, private readonly operations: OperationControlService,
    private readonly managedBuckets?: AliyunOssManagedBucketService) {}

  @Get()
  list() { return this.bindings.list(); }

  @Post()
  bind(@Req() request: AuthenticatedPlatformRequest, @Body() payload: BindBillingOssBucketDto) {
    return this.mutate(request, 'billing_oss_bucket_bind', { ...payload }, payload.bucketName,
      () => this.bindings.confirmation(payload), () => this.bindings.bind(payload));
  }

  @Post('create')
  create(@Req() request: AuthenticatedPlatformRequest, @Body() payload: CreateBillingOssBucketDto) {
    return this.mutate(request, 'billing_oss_bucket_create', { ...payload }, requireCurrentCloudWorkspaceId(),
      () => this.managedBuckets!.confirmation(payload), () => this.managedBuckets!.create(payload));
  }

  @Post(':ledgerId/end')
  end(@Req() request: AuthenticatedPlatformRequest, @Param('ledgerId') ledgerId: string) {
    return this.mutate(request, 'billing_oss_bucket_binding_end', { ledgerId }, ledgerId,
      () => this.bindings.endConfirmation(ledgerId), () => this.bindings.end(ledgerId));
  }

  private async mutate(request: AuthenticatedPlatformRequest, toolName: string, args: Record<string, unknown>, targetId: string,
    resolveConfirmation: () => Promise<{ targetId: string | null; targetSnapshot: Record<string, unknown>; summary: Record<string, unknown> }>,
    execute: () => Promise<Record<string, unknown>>) {
    if (!request.adminUser.isPlatformManager) throw new ForbiddenException('仅平台超管可声明或终止专用桶费用归属。');
    const metadata = readOperationRequestMetadata(request);
    if (request.authContext.source === 'mcp') return this.operations.executeConfirmed({
      context: request.authContext, metadata, toolName, arguments: args, targetType: 'billing_oss_bucket_binding', targetId,
      resolveConfirmation, execute: async () => ({ result: await execute() }),
    });
    const audit = { requestId: metadata.requestId, operationId: metadata.requestId, actorUserId: request.adminUser.id,
      source: request.authContext.source, oauthClientId: request.authContext.oauthClientId, toolName,
      targetType: 'billing_oss_bucket_binding', targetId, sanitizedInput: args };
    await this.operations.audit({ ...audit, phase: 'requested' });
    try {
      const result = await execute();
      await this.operations.audit({ ...audit, phase: 'succeeded', targetId: typeof result.ledgerId === 'string' ? result.ledgerId : targetId });
      return result;
    } catch (error) {
      await this.operations.audit({ ...audit, phase: 'failed', errorCode: 'OSS_BILLING_BINDING_FAILED' });
      throw error;
    }
  }
}
