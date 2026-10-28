import { Controller, Delete, Get, HttpCode, Param, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminAuthGuard } from './admin-auth.guard';
import { PlatformContainerImagesService } from './platform-container-images.service';

@Controller('admin/platform-container-images')
@UseGuards(AdminAuthGuard)
export class PlatformContainerImagesController {
  constructor(private readonly service: PlatformContainerImagesService) {}

  @Get()
  list() { return this.service.list(); }

  @Delete(':id')
  @HttpCode(200)
  remove(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    return this.service.remove(id, request.adminUser);
  }
}
