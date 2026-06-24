import { Body, Controller, Delete, Get, Param, Patch, Post, HttpCode, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CompetitionsService } from './competitions.service';
import { CreateCompetitionDto, UpdateCompetitionDto } from './dto/competition.dto';

@Controller('admin/competitions')
@UseGuards(AdminAuthGuard)
export class CompetitionsController {
  constructor(private readonly competitionsService: CompetitionsService) {}

  @Get()
  list() {
    return this.competitionsService.list();
  }

  @Post()
  create(@Body() body: CreateCompetitionDto) {
    return this.competitionsService.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateCompetitionDto) {
    return this.competitionsService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.competitionsService.delete(id);
  }
}
