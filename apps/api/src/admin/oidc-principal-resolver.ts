import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';
import { runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { KeycloakIdentityService, usesKeycloakRoles } from '../auth/keycloak-identity.service';
import { PrismaService } from '../database/prisma.service';

type ResolveOidcPrincipalInput = {
  issuer: string;
  subject: string;
};

@Injectable()
export class OidcPrincipalResolver {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    @Optional() private readonly identity?: KeycloakIdentityService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async resolve(input: ResolveOidcPrincipalInput, browserToken?: string) {
    if (usesKeycloakRoles()) {
      if (!this.identity || !this.prisma) throw new UnauthorizedException('Keycloak identity is not configured');
      const identity = await this.identity.resolve(input.subject, browserToken);
      return runInSystemCloudWorkspaceScope(async () => {
        const existing = await this.repository.getPlatformUserByOidcIdentity(input.issuer, input.subject);
        if (identity.role === 'admin') {
          const user = existing ?? await this.createIdentity(input, identity.username, null, true);
          // Keep persisted home-workspace and ownership records unchanged when an existing user is promoted.
          return { ...user, role: 'admin' as const, isPlatformManager: true, cloudWorkspaceId: null, status: 'active' as const };
        }
        const [workspaceId] = identity.workspaceIds;
        if (identity.workspaceIds.length !== 1 || !workspaceId ||
          (existing && existing.cloudWorkspaceId !== workspaceId && !existing.isPlatformManager)) {
          throw new ForbiddenException('No matching cloud workspace assignment');
        }
        const workspace = await this.prisma!.cloudWorkspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || workspace.archivedAt) throw new ForbiddenException('Cloud workspace is unavailable');
        if (existing) return { ...existing, role: identity.role, cloudWorkspaceId: workspaceId, isPlatformManager: false, status: 'active' as const };
        try {
          return await this.repository.createPlatformUser({
            id: randomUUID(), username: identity.username, cloudWorkspaceId: workspaceId, passwordHash: '',
            oidcIssuer: input.issuer, oidcSubject: input.subject, role: identity.role,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error;
          const created = await this.repository.getPlatformUserByOidcIdentity(input.issuer, input.subject);
          if (!created || created.cloudWorkspaceId !== workspaceId || created.isPlatformManager) {
            throw new ForbiddenException('Existing platform account requires an explicit identity binding');
          }
          return { ...created, role: identity.role, status: 'active' as const };
        }
      });
    }
    const user = await runInSystemCloudWorkspaceScope(() => this.repository.getPlatformUserByOidcIdentity(input.issuer, input.subject));

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('OIDC principal is not mapped to an active platform user');
    }

    return user;
  }

  private async createIdentity(input: ResolveOidcPrincipalInput, username: string, cloudWorkspaceId: string | null, isPlatformManager: boolean) {
    try {
      return await this.repository.createPlatformUser({
        id: randomUUID(), username, cloudWorkspaceId, isPlatformManager, passwordHash: '',
        oidcIssuer: input.issuer, oidcSubject: input.subject, role: isPlatformManager ? 'admin' : 'user',
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const created = await this.repository.getPlatformUserByOidcIdentity(input.issuer, input.subject);
      if (!created) throw new ForbiddenException('Existing platform account requires an explicit identity binding');
      return created;
    }
  }
}
