import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { KeycloakAdminService } from './admin/keycloak-admin.service';
import { PrismaService } from './database/prisma.service';

@Injectable()
export class OidcAdminBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(OidcAdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdminService: KeycloakAdminService,
  ) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const adminUsername = process.env.ADMIN_USERNAME?.trim() || 'admin';
    const issuer = process.env.OIDC_ISSUER?.trim() || 'http://localhost:8080/realms/cyber-range';
    const user = await this.prisma.platformUser.findUnique({ where: { id: adminUsername } });

    if (!user) {
      return;
    }

    const subject = await this.keycloakAdminService.findUserSubjectByUsername(adminUsername);

    if (!subject) {
      this.logger.warn(`Keycloak user not found for seeded admin: ${adminUsername}`);
      return;
    }

    if (user.oidcIssuer === issuer && user.oidcSubject === subject) {
      return;
    }

    await this.prisma.platformUser.update({
      where: { id: user.id },
      data: {
        oidcIssuer: issuer,
        oidcSubject: subject,
      },
    });
  }
}
