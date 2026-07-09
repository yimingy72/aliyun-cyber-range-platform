import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';
import { SessionUserProfile, verifySessionToken } from './admin-user-auth';
import { AdminSessionService } from './admin-session.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly adminSessionService: AdminSessionService,
    @Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      adminUser?: SessionUserProfile;
    }>();
    const authorizationHeader = request.headers.authorization ?? '';
    const token = this.readBearerToken(authorizationHeader);

    if (!token) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    await this.adminSessionService.ensureSeededAdminUser();

    const payload = verifySessionToken(token, this.adminSessionService.getSessionSecret());

    if (!payload) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    const user = await this.repository.getPlatformUserById(payload.sub);

    if (!user || user.status !== 'active' || user.role !== 'admin') {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    request.adminUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    return true;
  }

  private readBearerToken(authorizationHeader: string) {
    const [scheme, token] = authorizationHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }
}
