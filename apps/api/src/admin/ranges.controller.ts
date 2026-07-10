import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { CreateRangeInstanceDto, LaunchRangeInstanceDto, TriggerProvisionJobDto } from './dto/range-instance.dto';
import { RangeInstanceNodeActionsService } from './range-instance-node-actions.service';
import { RangeInstancesService } from './range-instances.service';

type AuthenticatedAdminRequest = {
  adminUser: SessionUserProfile;
};

@Controller('admin/ranges')
@UseGuards(AdminAuthGuard)
export class RangesController {
  constructor(
    private readonly rangeInstancesService: RangeInstancesService,
    private readonly rangeInstanceNodeActionsService: RangeInstanceNodeActionsService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest) {
    return this.rangeInstancesService.list(request.adminUser);
  }

  @Get(':id')
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeInstancesService.getById(id, request.adminUser);
  }

  @Patch(':id/draft')
  saveDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: SaveRangeInstanceDraftDto) {
    return this.rangeInstancesService.saveDraft(id, body, request.adminUser);
  }

  @Delete(':id')
  async delete(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    await this.rangeInstancesService.delete(id, request.adminUser);
  }

  @Delete(':id/draft')
  discardDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeInstancesService.discardDraft(id, request.adminUser);
  }

  @Post()
  create(@Req() request: AuthenticatedAdminRequest, @Body() body: CreateRangeInstanceDto) {
    return this.rangeInstancesService.create(body, request.adminUser);
  }

  @Post('launch')
  launch(@Req() request: AuthenticatedAdminRequest, @Body() body: LaunchRangeInstanceDto) {
    return this.rangeInstancesService.launch(body, request.adminUser);
  }

  @Post(':id/create')
  triggerCreate(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerCreate(id, request.adminUser);
  }

  @Post(':id/destroy')
  triggerDestroy(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerDestroy(id, request.adminUser);
  }

  @Post(':id/retry')
  triggerRetry(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerRetry(id, request.adminUser);
  }

  @Post(':id/apply')
  applyDraft(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.applyDraft(id, request.adminUser);
  }

  @Post(':id/sync-template')
  syncTemplate(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.syncTemplate(id, request.adminUser);
  }

  @Post(':id/nodes/:nodeId/actions/:action')
  runNodeAction(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.rangeInstanceNodeActionsService.run(
      id,
      nodeId,
      action,
      {
        ...this.sanitizeNodeActionPayload(body),
        ownerUserId: request.adminUser.id,
      },
      request.adminUser,
    );
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
