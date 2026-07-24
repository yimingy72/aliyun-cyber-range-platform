import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminAuthGuard } from './admin-auth.guard';
import { CreatePlatformImageTagDto } from './dto/platform-image-tag.dto';
import { ImageCatalogService } from './image-catalog.service';

@Controller('admin/platform-image-tags')
@UseGuards(AdminAuthGuard)
export class PlatformImageTagsController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  list() {
    return this.imageCatalogService.listPlatformImageTags();
  }

  @Post()
  create(@Req() request: AuthenticatedPlatformRequest, @Body() body: CreatePlatformImageTagDto) {
    return this.imageCatalogService.createPlatformImageTag(body, request.adminUser);
  }
}
