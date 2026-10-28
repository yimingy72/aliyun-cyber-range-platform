import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';

import { SessionUserProfile } from './admin-user-auth';
import { OidcJwtVerifier } from './oidc-jwt-verifier';
import { OidcPrincipalResolver } from './oidc-principal-resolver';
import type { RequestAuthContext } from '../auth/request-auth-context';
import type { CloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { CloudWorkspacesService } from './cloud-workspaces.service';
import { assertDelegatedApiScopes, hasDelegatedScopes, resolveDelegatedScopes } from '../auth/delegated-api-scopes';

type GuardRequest = {
  headers: Record<string, string | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
  adminUser?: SessionUserProfile;
  authContext?: RequestAuthContext;
  cloudWorkspaceScope?: CloudWorkspaceScope;
  rawHeaders?: string[];
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
    @Optional() private readonly cloudWorkspaces?: CloudWorkspacesService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const counts = new Map<string, number>();
    for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
      const name = request.rawHeaders![index].toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (['authorization', 'x-cloud-workspace-id', 'x-idempotency-key', 'idempotency-key', 'x-confirmation-id', 'x-operation-confirmation-id']
      .some(name => (counts.get(name) ?? 0) > 1 || request.headers[name] !== undefined && typeof request.headers[name] !== 'string'))
      throw new UnauthorizedException('Ambiguous authentication or operation headers');
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
      cloudWorkspaceId: user.cloudWorkspaceId ?? null,
      isPlatformManager: user.isPlatformManager === true,
      selectedCloudWorkspaceId: user.selectedCloudWorkspaceId ?? null,
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

    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const tokenScopes = (claims as typeof claims & { scopes?: string[] }).scopes;
    if (request.authContext.source === 'mcp' || hasDelegatedScopes(tokenScopes)) {
      const scopes = resolveDelegatedScopes(user.role, tokenScopes);
      assertDelegatedApiScopes(request.method ?? 'GET', path, scopes);
      request.authContext.delegatedScopes = [...scopes];
    }
    if (this.cloudWorkspaces && path !== '/admin/session' && (process.env.NODE_ENV !== 'test' || process.env.CLOUD_WORKSPACE_ENFORCE_TEST_SCOPE === '1')) {
      const metadataRoute = path === '/admin/cloud-workspaces' || /^\/admin\/cloud-workspaces\/[^/]+\/switch$/.test(path);
      request.cloudWorkspaceScope = await this.cloudWorkspaces.resolve(profile, metadataRoute ? undefined : request.headers['x-cloud-workspace-id']);
      request.authContext.cloudWorkspaceId = request.cloudWorkspaceScope.cloudWorkspaceId;
      const method = (request.method ?? 'GET').toUpperCase();
      const registryWrite = /^\/admin\/cloud-workspaces\/[^/]+\/switch$/.test(path)
        || /^\/admin\/cloud-workspaces\/[^/]+$/.test(path) && method === 'DELETE'
        || path === '/admin/cloud-contexts' || path === '/admin/tencent-cloud/regions/query';
      if (request.cloudWorkspaceScope.isReadOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !registryWrite) {
        throw new ForbiddenException('历史待核验空间为只读，请选择已绑定的云账号。');
      }
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
    if (pathname === '/admin/session' || pathname === '/admin/cloud-workspaces' || pathname.startsWith('/admin/cloud-workspaces/')) return true;
    if (AdminAuthGuard.AUTHENTICATED_USER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      return true;
    }

    if (pathname === '/admin/platform-images' && method === 'GET') {
      return true;
    }

    if (pathname === '/admin/platform-container-images' && method === 'GET') return true;

    if (pathname === '/admin/cloud-contexts' && method === 'GET') {
      return true;
    }

    if (pathname === '/admin/image-imports' || pathname.startsWith('/admin/image-imports/')) {
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
    return /^Bearer\s+([^\s,]+)$/i.exec(authorizationHeader)?.[1] ?? null;
  }

  private looksLikeJwt(token: string) {
    return token.split('.').length === 3;
  }
}
