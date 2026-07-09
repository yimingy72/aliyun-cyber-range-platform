import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';
import {
  resolveAdminSessionSecret,
  resolveSeededAdminCredentials,
  SessionUserProfile,
  signSessionToken,
  verifyPassword,
  hashPassword,
} from './admin-user-auth';

type LoginPayload = {
  username: string;
  password: string;
};

@Injectable()
export class AdminSessionService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository) {}

  getSessionSecret() {
    return resolveAdminSessionSecret();
  }

  async ensureSeededAdminUser() {
    const seededAdmin = resolveSeededAdminCredentials();
    const existingAdmin = await this.repository.getPlatformUserById(seededAdmin.id);

    if (!existingAdmin) {
      await this.repository.createPlatformUser({
        id: seededAdmin.id,
        username: seededAdmin.username,
        passwordHash: hashPassword(seededAdmin.password),
        role: 'admin',
        status: 'active',
      });

      return;
    }

    const update: {
      username?: string;
      passwordHash?: string;
    } = {};

    if (existingAdmin.username !== seededAdmin.username) {
      update.username = seededAdmin.username;
    }

    if (!verifyPassword(seededAdmin.password, existingAdmin.passwordHash)) {
      update.passwordHash = hashPassword(seededAdmin.password);
    }

    if (Object.keys(update).length > 0) {
      await this.repository.updatePlatformUser(existingAdmin.id, update);
    }
  }

  async createSession({ username, password }: LoginPayload) {
    await this.ensureSeededAdminUser();

    const user = await this.repository.getPlatformUserByUsername(username.trim());

    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return {
      token: signSessionToken(user, this.getSessionSecret()),
      profile: this.toSessionProfile(user),
    };
  }

  private toSessionProfile(user: { id: string; username: string; role: 'admin' | 'user' }): SessionUserProfile {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  }
}
