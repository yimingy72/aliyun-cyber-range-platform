import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { TeamsService } from './teams.service';

@Controller('admin/teams')
@UseGuards(AdminAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get()
  list(@Query('competitionId') competitionId?: string) {
    return this.teamsService.list(competitionId);
  }

  @Post()
  create(@Body() body: CreateTeamDto) {
    return this.teamsService.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateTeamDto) {
    return this.teamsService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.teamsService.delete(id);
  }
}
