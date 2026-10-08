import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';

import { SessionUserProfile } from './admin-user-auth';
import { OidcJwtVerifier } from './oidc-jwt-verifier';
import { OidcPrincipalResolver } from './oidc-principal-resolver';
import type { RequestAuthContext } from '../auth/request-auth-context';

type GuardRequest = {
  headers: Record<string, string | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
  adminUser?: SessionUserProfile;
  authContext?: RequestAuthContext;
};

@Injectable()
export class AdminAuthGuard implements CanActivate {
  private static readonly AUTHENTICATED_USER_PREFIXES = [
    '/admin/scenarios',
    '/admin/ranges',
    '/admin/instances',
    '/admin/provision-jobs',
  ] as const;

  constructor(
    private readonly oidcJwtVerifier?: OidcJwtVerifier,
    private readonly oidcPrincipalResolver?: OidcPrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const authorizationHeader = request.headers.authorization ?? '';
    const token = this.readBearerToken(authorizationHeader);

    if (!token) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    if (!this.looksLikeJwt(token)) {
      throw new UnauthorizedException('Missing or invalid admin token');
    }

    return this.authenticateOidc(request, token);
  }

  private async authenticateOidc(
    request: GuardRequest,
    token: string,
  ) {
    if (!this.oidcJwtVerifier || !this.oidcPrincipalResolver) {
      throw new UnauthorizedException('OIDC authentication is not configured');
    }

    const claims = await this.oidcJwtVerifier.verifyAccessToken(token);
    const user = await this.oidcPrincipalResolver.resolve({
      issuer: claims.issuer,
      subject: claims.subject,
    });

    const profile = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    request.adminUser = profile;
    request.authContext = {
      user: profile,
      source: claims.authorizedParty === (process.env.MCP_GATEWAY_CLIENT_ID?.trim() || 'mcp-gateway') ? 'mcp' : 'web',
      oauthClientId: claims.authorizedParty,
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

    if (pathname === '/admin/cloud-contexts' && method === 'GET') {
      return true;
    }

    if (pathname.startsWith('/admin/image-imports')) {
      return true;
    }
    if (/^\/admin\/image-catalog\/custom\/[^/]+$/.test(pathname) && method === 'DELETE') return true;

    if (/^\/admin\/platform-images\/[^/]+$/.test(pathname) && (method === 'PATCH' || method === 'DELETE')) {
      return true;
    }

    if (/^\/admin\/platform-images\/[^/]+\/tags$/.test(pathname) && method === 'PUT') {
      return true;
    }

    if (/^\/admin\/platform-images\/[^/]+\/(enable|disable)$/.test(pathname) && method === 'POST') {
      return true;
    }

    if (pathname === '/admin/platform-image-tags' && method === 'GET') {
      return true;
    }

    if (pathname === '/admin/system-config/instance-type-availability' && method === 'GET') {
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

  private looksLikeJwt(token: string) {
    return token.split('.').length === 3;
  }
}
