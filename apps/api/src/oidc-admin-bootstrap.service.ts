import { Injectable, Logger } from '@nestjs/common';

import { KeycloakAdminService } from './admin/keycloak-admin.service';
import { PrismaService } from './database/prisma.service';

@Injectable()
export class OidcAdminBootstrapService {
  private readonly logger = new Logger(OidcAdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdminService: KeycloakAdminService,
  ) {}

  async initialize() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const adminUsername = process.env.ADMIN_USERNAME?.trim() || 'admin';
    const issuer = process.env.OIDC_ISSUER?.trim() || 'http://localhost:8080/realms/cyber-range';
    const user = await this.prisma.platformUser.findUnique({ where: { username: adminUsername } })
      ?? await this.prisma.platformUser.findUnique({ where: { id: 'admin' } });

    if (!user) {
      return;
    }

    if (user.role !== 'admin' || user.status !== 'active') {
      this.logger.warn('Configured platform administrator is not an active admin; identity binding was skipped.');
      return;
    }

    const subject = await this.keycloakAdminService.findUserSubjectByUsername(adminUsername);

    if (!subject) {
      this.logger.warn(`Keycloak user not found for seeded admin: ${adminUsername}`);
      return;
    }

    if (user.username === adminUsername && user.oidcIssuer === issuer && user.oidcSubject === subject) {
      return;
    }

    await this.prisma.platformUser.update({
      where: { id: user.id },
      data: {
        username: adminUsername,
        oidcIssuer: issuer,
        oidcSubject: subject,
      },
    });
  }
}
