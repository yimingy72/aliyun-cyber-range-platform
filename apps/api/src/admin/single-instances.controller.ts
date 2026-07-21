import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import {
  LaunchSingleInstanceDto,
  TriggerSingleInstanceBatchDestroyDto,
  TriggerSingleInstanceDestroyDto,
} from './dto/single-instance.dto';
import { SingleInstancesService } from './single-instances.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

type AuthenticatedAdminRequest = AuthenticatedPlatformRequest;

const DEFAULT_SINGLE_INSTANCE_EXPIRY_MS = 8 * 60 * 60 * 1_000;

@Controller('admin/instances')
@UseGuards(AdminAuthGuard)
export class SingleInstancesController {
  constructor(
    private readonly singleInstancesService: SingleInstancesService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest, @Query('view') view?: 'active' | 'history') {
    return this.singleInstancesService.list(request.adminUser, view);
  }

  @Get(':id')
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.singleInstancesService.getById(id, request.adminUser);
  }

  @Get(':id/access')
  getAccess(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      void this.operationControlService.audit({
        operationId: `request:${metadata.requestId}`,
        requestId: metadata.requestId,
        actorUserId: request.adminUser.id,
        source: 'mcp',
        oauthClientId: request.authContext.oauthClientId,
        toolName: 'single_instance_get_access',
        phase: 'succeeded',
        targetType: 'single_instance',
        targetId: id,
      });
    }
    return this.singleInstancesService.getAccessById(id, request.adminUser);
  }

  @Post('launch')
  launch(@Req() request: AuthenticatedAdminRequest, @Body() body: LaunchSingleInstanceDto) {
    const input: LaunchSingleInstanceDto & { expiresAt: string } = {
      ...body,
      expiresAt: body.expiresAt ?? new Date(Date.now() + DEFAULT_SINGLE_INSTANCE_EXPIRY_MS).toISOString(),
    };

    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `launch:${body.platformImageAssetId}:${body.name}` },
        toolName: 'single_instance_batch_launch',
        arguments: input as unknown as Record<string, unknown>,
        targetType: 'single_instance_batch',
        resolveConfirmation: () => this.singleInstancesService.prepareLaunchConfirmation(input, request.adminUser.id),
        execute: async () => {
          const result = await this.singleInstancesService.launch(input, request.adminUser.id);
          return { batchId: result.batch.id, instanceIds: result.instances.map((instance) => instance.id) };
        },
      });
    }
    return this.singleInstancesService.launch(input, request.adminUser.id);
  }

  @Post(':id/destroy')
  destroy(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerSingleInstanceDestroyDto) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `destroy:${id}` },
        toolName: 'single_instance_destroy',
        arguments: { singleInstanceId: id },
        targetType: 'single_instance',
        targetId: id,
        resolveConfirmation: () => this.singleInstancesService.prepareDestroyConfirmation(id, request.adminUser),
        execute: async () => {
          const job = await this.singleInstancesService.destroy(id, request.adminUser);
          return { singleInstanceId: id, jobId: job.id };
        },
      });
    }
    return this.singleInstancesService.destroy(id, request.adminUser);
  }

  @Post('batches/:id/destroy-all')
  destroyBatch(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() _body: TriggerSingleInstanceBatchDestroyDto,
  ) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `destroy-batch:${id}` },
        toolName: 'single_instance_batch_destroy',
        arguments: { batchId: id },
        targetType: 'single_instance_batch',
        targetId: id,
        resolveConfirmation: () => this.singleInstancesService.prepareDestroyBatchConfirmation(id, request.adminUser),
        execute: () => this.singleInstancesService.destroyBatch(id, request.adminUser),
      });
    }
    return this.singleInstancesService.destroyBatch(id, request.adminUser);
  }

  @Post(':id/retry')
  retry(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerSingleInstanceDestroyDto) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `retry:${id}` },
        toolName: 'single_instance_retry',
        arguments: { singleInstanceId: id },
        targetType: 'single_instance',
        targetId: id,
        resolveConfirmation: () => this.singleInstancesService.prepareRetryConfirmation(id, request.adminUser),
        execute: async () => {
          const job = await this.singleInstancesService.retry(id, request.adminUser);
          return { singleInstanceId: id, jobId: job.id };
        },
      });
    }
    return this.singleInstancesService.retry(id, request.adminUser);
  }

  @Post(':id/actions/:action')
  runAction(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Param('action') action: 'reboot' | 'open-vnc' | 'pack-image',
    @Body() body: Record<string, unknown>,
  ) {
    const payload = { ownerUserId: request.adminUser.id, ...this.sanitizeActionPayload(body) };
    if (request.authContext.source === 'mcp' && action === 'open-vnc') {
      const metadata = readOperationRequestMetadata(request);
      return this.singleInstancesService.runAction(id, action, request.adminUser, payload).then((result) => {
        void this.operationControlService.audit({
          operationId: `request:${metadata.requestId}`,
          requestId: metadata.requestId,
          actorUserId: request.adminUser.id,
          source: 'mcp',
          oauthClientId: request.authContext.oauthClientId,
          toolName: 'single_instance_open_vnc',
          phase: 'succeeded',
          targetType: 'single_instance',
          targetId: id,
        });
        return result;
      });
    }
    if (request.authContext.source === 'mcp' && (action === 'reboot' || action === 'pack-image')) {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `${action}:${id}` },
        toolName: `single_instance_${action}`,
        arguments: { singleInstanceId: id, ...payload },
        targetType: 'single_instance',
        targetId: id,
        resolveConfirmation: () => this.singleInstancesService.prepareActionConfirmation(id, action, request.adminUser),
        execute: () => this.singleInstancesService.runAction(id, action, request.adminUser, payload),
      });
    }
    return this.singleInstancesService.runAction(id, action, request.adminUser, {
      ...payload,
    });
  }

  private sanitizeActionPayload(body: Record<string, unknown>) {
    const keys = ['displayName', 'defaultHostName', 'defaultPassword', 'description'] as const;
    const payload: Record<string, string> = {};

    for (const key of keys) {
      const value = body[key];

      if (value === undefined) {
        continue;
      }

      if (typeof value !== 'string') {
        throw new BadRequestException(`${key} must be a string`);
      }

      payload[key] = value;
    }

    return payload;
  }
}
