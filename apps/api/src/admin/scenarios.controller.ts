import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import {
  CreateRangeTemplateDto,
  RangeTemplateRevisionDto,
  SaveRangeTemplateTopologyDto,
  UpdateRangeTemplateDto,
} from './dto/range-template.dto';
import { RangeTemplatesService } from './range-templates.service';

type AuthenticatedAdminRequest = {
  adminUser: SessionUserProfile;
};

@Controller('admin/scenarios')
@UseGuards(AdminAuthGuard)
export class ScenariosController {
  constructor(private readonly rangeTemplatesService: RangeTemplatesService) {}

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
    return this.rangeTemplatesService.publishToPlatform(id, body.expectedRevision, request.adminUser);
  }

  @Post(':id/unshare')
  @HttpCode(200)
  unshare(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() body: RangeTemplateRevisionDto,
  ) {
    return this.rangeTemplatesService.returnToPrivate(id, body.expectedRevision, request.adminUser);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    await this.rangeTemplatesService.delete(id, request.adminUser);
  }
}
