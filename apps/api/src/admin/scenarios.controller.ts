import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import { CreateRangeTemplateDto, UpdateRangeTemplateDto } from './dto/range-template.dto';
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
    return this.rangeTemplatesService.update(id, body, request.adminUser);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.publish(id, request.adminUser);
  }

  @Post(':id/validate')
  @HttpCode(200)
  validate(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.validate(id, request.adminUser);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.unpublish(id, request.adminUser);
  }

  @Post(':id/share')
  @HttpCode(200)
  share(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.share(id, request.adminUser);
  }

  @Post(':id/unshare')
  @HttpCode(200)
  unshare(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.rangeTemplatesService.unshare(id, request.adminUser);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    await this.rangeTemplatesService.delete(id, request.adminUser);
  }
}
