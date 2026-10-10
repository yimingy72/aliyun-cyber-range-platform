import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { SaveRangeInstanceAsTemplateDto } from './dto/range-instance-template-copy.dto';
import { SyncRangeInstanceTemplateDto } from './dto/range-instance-template-sync.dto';
import {
  ApplyRangeInstanceDraftDto,
  PreviewRangeInstanceDraftDto,
  CreateRangeInstanceDto,
  LaunchRangeInstanceDto,
  TriggerProvisionJobDto,
} from './dto/range-instance.dto';
import { RangeInstanceNodeActionsService } from './range-instance-node-actions.service';
import { RangeInstancesService } from './range-instances.service';
import { RangeNetworkDiagnosticsQueryDto } from './dto/range-network-diagnostics-query.dto';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

type AuthenticatedAdminRequest = AuthenticatedPlatformRequest;

@Controller('admin/ranges')
@UseGuards(AdminAuthGuard)
export class RangesController {
  constructor(
    private readonly rangeInstancesService: RangeInstancesService,
    private readonly rangeInstanceNodeActionsService: RangeInstanceNodeActionsService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest, @Query('view') view?: 'active' | 'history') {
    return this.rangeInstancesService.list(request.adminUser, view);
  }

  @Get(':id')
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Query() query: RangeNetworkDiagnosticsQueryDto = {}) {
    return query.includeNetworkDiagnostics === true
      ? this.rangeInstancesService.getById(id, request.adminUser, { includeNetworkDiagnostics: true })
      : this.rangeInstancesService.getById(id, request.adminUser);
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
        toolName: 'range_instance_get_access',
        phase: 'succeeded',
        targetType: 'range_instance',
        targetId: id,
      });
    }
    return this.rangeInstancesService.getAccessById(id, request.adminUser);
  }

  @Patch(':id/draft')
  saveDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: SaveRangeInstanceDraftDto) {
    return this.rangeInstancesService.saveDraft(id, body, request.adminUser);
  }

  @Delete(':id/draft')
  discardDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Query('expectedDraftRevision') expectedDraftRevision?: string) {
    if (expectedDraftRevision === undefined && request.authContext.source === 'mcp') {
      throw new BadRequestException('MCP 放弃草稿必须指定 expectedDraftRevision。');
    }
    if (expectedDraftRevision !== undefined && (!/^[1-9]\d*$/.test(expectedDraftRevision) || !Number.isSafeInteger(Number(expectedDraftRevision)))) {
      throw new BadRequestException('expectedDraftRevision 必须为正整数。');
    }
    return this.rangeInstancesService.discardDraft(id, request.adminUser, expectedDraftRevision === undefined ? undefined : Number(expectedDraftRevision));
  }

  @Post()
  create(@Req() request: AuthenticatedAdminRequest, @Body() body: CreateRangeInstanceDto) {
    return this.rangeInstancesService.create(body, request.adminUser);
  }

  @Post('launch')
  launch(@Req() request: AuthenticatedAdminRequest, @Body() body: LaunchRangeInstanceDto) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata,
        toolName: 'range_instance_launch',
        arguments: body as unknown as Record<string, unknown>,
        targetType: 'range_instance',
        resolveConfirmation: () => this.rangeInstancesService.prepareLaunchConfirmation(body, request.adminUser),
        execute: async () => {
          const result = await this.rangeInstancesService.launch(body, request.adminUser);
          return { rangeInstanceId: result.id, jobId: result.lastJobId };
        },
      });
    }
    return this.rangeInstancesService.launch(body, request.adminUser);
  }

  @Post(':id/create')
  triggerCreate(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerCreate(id, request.adminUser);
  }

  @Post(':id/destroy')
  triggerDestroy(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    if (request.authContext.source === 'mcp') {
      const metadata = readOperationRequestMetadata(request);
      return this.operationControlService.executeConfirmed({
        context: request.authContext,
        metadata,
        toolName: 'range_instance_destroy',
        arguments: { rangeInstanceId: id },
        targetType: 'range_instance',
        targetId: id,
        resolveConfirmation: () => this.rangeInstancesService.prepareDestroyConfirmation(id, request.adminUser),
        execute: async () => {
          const job = await this.rangeInstancesService.triggerDestroy(id, request.adminUser);
          return { rangeInstanceId: id, jobId: job.id };
        },
      });
    }
    return this.rangeInstancesService.triggerDestroy(id, request.adminUser);
  }

  @Post(':id/retry')
  triggerRetry(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    if (request.authContext.source === 'mcp') {
      return this.confirmedMcpAction(request, 'range_instance_retry', id, { rangeInstanceId: id }, false, async () => {
        const job = await this.rangeInstancesService.triggerRetry(id, request.adminUser);
        return { rangeInstanceId: id, jobId: job.id };
      });
    }
    return this.rangeInstancesService.triggerRetry(id, request.adminUser);
  }

  @Post(':id/preview')
  previewDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: PreviewRangeInstanceDraftDto) {
    return this.rangeInstancesService.previewDraft(id, body, request.adminUser);
  }

  @Post(':id/apply')
  applyDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: ApplyRangeInstanceDraftDto) {
    if (request.authContext.source === 'mcp') {
      return this.confirmedMcpAction(
        request,
        'range_instance_topology_apply',
        id,
        { rangeInstanceId: id, expectedDraftRevision: body.expectedDraftRevision, previewToken: body.previewToken },
        true,
        async () => {
          const job = await this.rangeInstancesService.applyDraft(id, body, request.adminUser);
          return { rangeInstanceId: id, jobId: job.id };
        },
      );
    }
    return this.rangeInstancesService.applyDraft(id, body, request.adminUser);
  }

  @Post(':id/templates')
  saveAsNewTemplate(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: SaveRangeInstanceAsTemplateDto) {
    const metadata = readOperationRequestMetadata(request);
    if (!metadata.idempotencyKey) throw new BadRequestException('A stable x-idempotency-key is required');
    return this.rangeInstancesService.saveAsNewTemplate(id, body, request.adminUser, metadata.idempotencyKey);
  }

  @Post(':id/sync-template')
  syncTemplate(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() body: SyncRangeInstanceTemplateDto,
  ) {
    if (request.authContext.source === 'mcp') {
      return this.confirmedMcpAction(request, 'range_instance_sync_template', id, {
        rangeInstanceId: id,
        expectedDraftRevision: body.expectedDraftRevision,
        expectedTemplateRevision: body.expectedTemplateRevision,
      }, false, async () => {
        const template = await this.rangeInstancesService.syncTemplate(id, body, request.adminUser);
        return { rangeInstanceId: id, templateId: template.id };
      });
    }
    return this.rangeInstancesService.syncTemplate(id, body, request.adminUser);
  }

  @Post(':id/nodes/:nodeId/actions/:action')
  runNodeAction(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dnsAction = action === 'verify-dns' || action === 'apply-dns';
    if (dnsAction && body && Object.keys(body).length) throw new BadRequestException('DNS 操作不接受自定义参数。');
    const payload = dnsAction ? {} : {
      ...this.sanitizeNodeActionPayload(body),
      ownerUserId: request.adminUser.id,
    };

    if (request.authContext.source === 'mcp' && action === 'open-vnc') {
      const metadata = readOperationRequestMetadata(request);
      return this.rangeInstanceNodeActionsService.run(id, nodeId, action, payload, request.adminUser).then((result) => {
        void this.operationControlService.audit({
          operationId: `request:${metadata.requestId}`,
          requestId: metadata.requestId,
          actorUserId: request.adminUser.id,
          source: 'mcp',
          oauthClientId: request.authContext.oauthClientId,
          toolName: 'range_instance_node_open_vnc',
          phase: 'succeeded',
          targetType: 'range_instance_node',
          targetId: `${id}:${nodeId}`,
        });
        return result;
      });
    }

    if (request.authContext.source === 'mcp') {
      return this.confirmedMcpAction(
        request,
        dnsAction ? `range_instance_node_${action.replace('-', '_')}` : `range_instance_node_${action}`,
        id,
        { rangeInstanceId: id, nodeId, action, ...payload },
        action === 'stop',
        async () => {
          const result = await this.rangeInstanceNodeActionsService.run(id, nodeId, action, payload, request.adminUser);
          return { rangeInstanceId: id, nodeId, ...result };
        },
        { nodeId },
      );
    }

    return this.rangeInstanceNodeActionsService.run(id, nodeId, action, payload, request.adminUser);
  }

  @Post(':id/nodes/:nodeId/pack-image-validation')
  validateNodePackImage(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Param('nodeId') nodeId: string, @Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['displayName', 'description'].includes(key)) || typeof body.displayName !== 'string' || !body.displayName.trim())
      throw new BadRequestException('参数核验只接受明确镜像名称和可选描述。');
    return this.rangeInstanceNodeActionsService.run(id, nodeId, 'pack-image', this.sanitizeNodeActionPayload(body), request.adminUser, undefined, 'dry-run');
  }

  private confirmedMcpAction<TResult extends Record<string, unknown>>(
    request: AuthenticatedAdminRequest,
    toolName: string,
    rangeInstanceId: string,
    argumentsValue: Record<string, unknown>,
    destructive: boolean,
    execute: () => Promise<TResult>,
    details: Record<string, unknown> = {},
  ) {
    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata,
      toolName,
      arguments: argumentsValue,
      targetType: 'range_instance',
      targetId: rangeInstanceId,
      resolveConfirmation: () =>
        this.rangeInstancesService.prepareActionConfirmation(
          rangeInstanceId,
          toolName,
          request.adminUser,
          destructive,
          details,
        ),
      execute,
    });
  }

  private sanitizeNodeActionPayload(body: Record<string, unknown>) {
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
