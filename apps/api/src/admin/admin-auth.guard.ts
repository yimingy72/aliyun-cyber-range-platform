import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';
import { hasValidSessionFingerprint, SessionUserProfile, verifySessionToken } from './admin-user-auth';
import { AdminSessionService } from './admin-session.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  private static readonly AUTHENTICATED_USER_PREFIXES = ['/admin/scenarios', '/admin/ranges'] as const;

  constructor(
    private readonly adminSessionService: AdminSessionService,
    @Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      originalUrl?: string;
      url?: string;
      method?: string;
      adminUser?: SessionUserProfile;
    }>();
    const authorizationHeader = request.headers.authorization ?? '';
    const token = this.readBearerToken(authorizationHeader);

    if (!token) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    const payload = verifySessionToken(token, this.adminSessionService.getSessionSecret());

    if (!payload) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    const user = await this.repository.getPlatformUserById(payload.sub);

    if (!user || user.status !== 'active' || !hasValidSessionFingerprint(payload, user)) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    request.adminUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    if (this.requiresAdmin(request) && user.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }

  private requiresAdmin(request: { originalUrl?: string; url?: string; method?: string }) {
    const pathname = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const method = (request.method ?? 'GET').toUpperCase();

    if (!this.isAuthenticatedUserRoute(pathname, method)) {
      return true;
    }

    return false;
  }

  private isAuthenticatedUserRoute(pathname: string, method: string) {
    if (AdminAuthGuard.AUTHENTICATED_USER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return true;
    }

    if (pathname === '/admin/platform-images' && method === 'GET') {
      return true;
    }

    if (/^\/admin\/platform-images\/[^/]+$/.test(pathname) && (method === 'PATCH' || method === 'DELETE')) {
      return true;
    }

    if (/^\/admin\/platform-images\/[^/]+\/(enable|disable)$/.test(pathname) && method === 'POST') {
      return true;
    }

    if ((pathname === '/admin/image-catalog/public' || pathname === '/admin/image-catalog/custom') && method === 'GET') {
      return true;
    }

    return false;
  }

  private readBearerToken(authorizationHeader: string) {
    const [scheme, token] = authorizationHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }
}
