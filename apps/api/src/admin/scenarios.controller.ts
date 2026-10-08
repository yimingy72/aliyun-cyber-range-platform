import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import {
  CreateRangeTemplateDto,
  RangeTemplateRevisionDto,
  SaveRangeTemplateTopologyDto,
  UpdateRangeTemplateDto,
} from './dto/range-template.dto';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { RangeTemplatesService } from './range-templates.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

type AuthenticatedAdminRequest = AuthenticatedPlatformRequest;

@Controller('admin/scenarios')
@UseGuards(AdminAuthGuard)
export class ScenariosController {
  constructor(
    private readonly rangeTemplatesService: RangeTemplatesService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest, @Query('view') view?: string) {
    return this.rangeTemplatesService.list(request.adminUser, view);
  }

  @Get(':id')
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.getById(id, request.adminUser);
  }

  @Post()
  create(@Req() request: AuthenticatedAdminRequest, @Body() body: CreateRangeTemplateDto) {
    return this.rangeTemplatesService.create(body, request.adminUser);
  }

  @Post(':id/clone')
  clone(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.clone(id, request.adminUser);
  }

  @Patch(':id')
  update(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: UpdateRangeTemplateDto) {
    return this.rangeTemplatesService.updateMetadata(id, body, request.adminUser);
  }

  @Post(':id/validate-and-save')
  @HttpCode(200)
  validateAndSave(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() body: SaveRangeTemplateTopologyDto,
  ) {
    return this.rangeTemplatesService.validateAndSave(id, body, request.adminUser);
  }

  @Post(':id/share')
  @HttpCode(200)
  share(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() body: RangeTemplateRevisionDto,
  ) {
    return this.confirmedMcpLifecycle(
      request,
      'range_template_publish',
      id,
      { templateId: id, expectedRevision: body.expectedRevision },
      false,
      () => this.rangeTemplatesService.publishToPlatform(id, body.expectedRevision, request.adminUser),
    );
  }

  @Post(':id/unshare')
  @HttpCode(200)
  unshare(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() body: RangeTemplateRevisionDto,
  ) {
    return this.confirmedMcpLifecycle(
      request,
      'range_template_return_to_private',
      id,
      { templateId: id, expectedRevision: body.expectedRevision },
      false,
      () => this.rangeTemplatesService.returnToPrivate(id, body.expectedRevision, request.adminUser),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.confirmedMcpLifecycle(
      request,
      'range_template_delete',
      id,
      { templateId: id },
      true,
      async () => {
        await this.rangeTemplatesService.delete(id, request.adminUser);
        return { deleted: true };
      },
    );
  }

  private confirmedMcpLifecycle<TResult extends Record<string, unknown>>(
    request: AuthenticatedAdminRequest,
    toolName: 'range_template_publish' | 'range_template_return_to_private' | 'range_template_delete',
    templateId: string,
    argumentsValue: Record<string, unknown>,
    destructive: boolean,
    execute: () => Promise<TResult>,
  ) {
    if (request.authContext.source !== 'mcp') {
      return execute();
    }

    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata,
      toolName,
      arguments: argumentsValue,
      targetType: 'range_template',
      targetId: templateId,
      resolveConfirmation: async () => ({
        targetId: templateId,
        targetSnapshot: { templateId },
        summary: { templateId, action: toolName, destructive },
      }),
      execute: async () => ({ result: await execute() }),
    });
  }
}
