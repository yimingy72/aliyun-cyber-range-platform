import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { ADMIN_REPOSITORY, type AdminRepository } from './admin.repository';
import { hasValidSessionFingerprint, type SessionUserProfile, verifySessionToken } from './admin-user-auth';
import { AdminSessionService } from './admin-session.service';
import { CollectPlatformImageDto, ListPlatformImagesDto, UpdatePlatformImageDto } from './dto/platform-image.dto';
import { ImageCatalogService } from './image-catalog.service';

type AuthenticatedAdminRequest = {
  headers: Record<string, string | undefined>;
  adminUser: SessionUserProfile;
};

@Controller('admin/platform-images')
export class PlatformImagesController {
  constructor(
    private readonly imageCatalogService: ImageCatalogService,
    private readonly adminSessionService: AdminSessionService,
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
  ) {}

  @Get()
  @UseGuards(AdminAuthGuard)
  list(@Req() request: AuthenticatedAdminRequest, @Query() query: ListPlatformImagesDto) {
    return this.imageCatalogService.listPlatformAssets(request.adminUser.id, query.view);
  }

  @Post()
  @UseGuards(AdminAuthGuard)
  collect(@Body() body: CollectPlatformImageDto) {
    return this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName);
  }

  @Patch(':id')
  @UseGuards(AdminAuthGuard)
  update(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: UpdatePlatformImageDto) {
    return this.imageCatalogService.updatePlatformAsset(id, body, request.adminUser);
  }

  @Post(':id/enable')
  @UseGuards(AdminAuthGuard)
  enable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, true, request.adminUser);
  }

  @Post(':id/disable')
  @UseGuards(AdminAuthGuard)
  disable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, false, request.adminUser);
  }

  @Post(':id/publish')
  @HttpCode(200)
  async publish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    const currentUser = await this.authenticateUser(request);

    return this.imageCatalogService.updatePlatformAsset(id, { visibility: 'platform' }, currentUser);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  async unpublish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    const currentUser = await this.authenticateUser(request);

    return this.imageCatalogService.updatePlatformAsset(id, { visibility: 'private' }, currentUser);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AdminAuthGuard)
  remove(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.removePlatformAsset(id, request.adminUser);
  }

  private async authenticateUser(request: Pick<AuthenticatedAdminRequest, 'headers'>): Promise<SessionUserProfile> {
    const authorizationHeader = request.headers.authorization ?? '';
    const [scheme, token] = authorizationHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    const payload = verifySessionToken(token, this.adminSessionService.getSessionSecret());

    if (!payload) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    const user = await this.adminRepository.getPlatformUserById(payload.sub);

    if (!user || user.status !== 'active' || !hasValidSessionFingerprint(payload, user)) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  }
}
