import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CreateRangeTemplateDto, UpdateRangeTemplateDto } from './dto/range-template.dto';
import { RangeTemplatesService } from './range-templates.service';

@Controller('admin/scenarios')
@UseGuards(AdminAuthGuard)
export class ScenariosController {
  constructor(private readonly rangeTemplatesService: RangeTemplatesService) {}

  @Get()
  list() {
    return this.rangeTemplatesService.list();
  }

  @Post()
  create(@Body() body: CreateRangeTemplateDto) {
    return this.rangeTemplatesService.create(body);
  }

  @Post(':id/clone')
  clone(@Param('id') id: string) {
    return this.rangeTemplatesService.clone(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateRangeTemplateDto) {
    return this.rangeTemplatesService.update(id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Param('id') id: string) {
    return this.rangeTemplatesService.publish(id);
  }

  @Post(':id/validate')
  @HttpCode(200)
  validate(@Param('id') id: string) {
    return this.rangeTemplatesService.validate(id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@Param('id') id: string) {
    return this.rangeTemplatesService.unpublish(id);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.rangeTemplatesService.delete(id);
  }
}
