import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { UserRole, UserStatus } from './admin.repository';

type CreateKeycloakUserInput = {
  username: string;
  loginUsername?: string;
  password: string;
  role: UserRole;
  status: UserStatus;
};

type UpdateKeycloakRoleInput = {
  subject: string;
  role: UserRole;
};

type UpdateKeycloakStatusInput = {
  subject: string;
  status: UserStatus;
};

type ResetKeycloakPasswordInput = {
  subject: string;
  password: string;
};

class KeycloakAdminError extends ServiceUnavailableException {
  constructor(message: string, readonly upstreamStatus?: number) {
    super(upstreamStatus ? `${message} (identity service HTTP ${upstreamStatus})` : message);
    this.name = 'KeycloakAdminError';
  }
}

type KeycloakRealmRole = {
  id: string;
  name: string;
  clientRole: boolean;
  composite: boolean;
};

@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  async createUser(input: CreateKeycloakUserInput): Promise<string> {
    const loginUsername = input.loginUsername ?? input.username;
    const identityEmail = input.loginUsername
      ? `${createHash('sha256').update(loginUsername).digest('hex')}@example.local`
      : `${input.username}@example.local`;
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${this.realmAdminUrl()}/users`, {
        signal: AbortSignal.timeout(5_000),
        method: 'POST',
        headers: this.jsonHeaders(accessToken),
        body: JSON.stringify({
          username: loginUsername,
          enabled: input.status === 'active',
          emailVerified: true,
          firstName: 'Platform',
          lastName: 'User',
          email: identityEmail,
          credentials: [{ type: 'password', value: input.password, temporary: false }],
          requiredActions: [],
        }),
      });
    } catch {
      this.logger.error('Identity creation outcome is unknown after a transport failure');
      throw new ServiceUnavailableException('Identity creation outcome is unknown; reconcile the identity before retrying creation');
    }

    if (response.status === 409) {
      throw new ConflictException('Username already exists');
    }

    if (response.status === 400) {
      throw new BadRequestException('Identity service rejected user creation (HTTP 400)');
    }

    if (response.status !== 201) {
      throw new KeycloakAdminError('Failed to create Keycloak user', response.status);
    }

    const location = response.headers.get('location');
    let subject = location?.split('/').pop();
    if (!subject) {
      try {
        subject = await this.findUserSubjectByUsername(loginUsername) ?? undefined;
      } catch {
        this.logger.error('Created identity could not be identified for setup or cleanup');
        throw new ServiceUnavailableException('Created identity could not be identified; reconcile the identity before retrying creation');
      }
    }

    if (!subject) {
      throw new ServiceUnavailableException('Created identity could not be identified; reconcile the identity before retrying creation');
    }

    try {
      await this.assignRealmRole(accessToken, subject, input.role);
    } catch (error) {
      try {
        await this.deleteUser(subject);
      } catch {
        this.logger.error('Failed to remove a newly created identity after role setup failed');
        throw new ServiceUnavailableException('Created identity cleanup failed; reconcile the identity before retrying creation');
      }
      throw error;
    }

    return subject;
  }

  async deleteUser(subject: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.realmAdminUrl()}/users/${subject}`, {
      signal: AbortSignal.timeout(5_000),
      method: 'DELETE',
      headers: this.jsonHeaders(accessToken),
    });
    if (response.status !== 204 && response.status !== 404) {
      throw new KeycloakAdminError('Failed to delete Keycloak user', response.status);
    }
  }

  async updateUserRole(input: UpdateKeycloakRoleInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    await this.replaceRealmRoles(accessToken, input.subject, input.role);
  }

  async updateUserStatus(input: UpdateKeycloakStatusInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.realmAdminUrl()}/users/${input.subject}`, {
      signal: AbortSignal.timeout(5_000),
      method: 'PUT',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({ enabled: input.status === 'active' }),
    });

    if (response.status !== 204) {
      throw new KeycloakAdminError('Failed to update Keycloak user status', response.status);
    }
  }

  async resetUserPassword(input: ResetKeycloakPasswordInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.realmAdminUrl()}/users/${input.subject}/reset-password`, {
      signal: AbortSignal.timeout(5_000),
      method: 'PUT',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({ type: 'password', value: input.password, temporary: false }),
    });

    if (response.status !== 204) {
      throw new KeycloakAdminError('Failed to reset Keycloak user password', response.status);
    }

    try {
      const requiredActionsResponse = await fetch(`${this.realmAdminUrl()}/users/${input.subject}`, {
        signal: AbortSignal.timeout(5_000),
        method: 'PUT',
        headers: this.jsonHeaders(accessToken),
        body: JSON.stringify({ requiredActions: [] }),
      });
      if (requiredActionsResponse.status !== 204) {
        throw new KeycloakAdminError('Failed to clear Keycloak required actions', requiredActionsResponse.status);
      }
    } catch {
      // The credential change already succeeded; cleanup cannot truthfully turn it into a failed reset.
      this.logger.warn('Password was reset, but clearing identity required actions failed');
    }
  }

  async findUserSubjectByUsername(username: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const searchParams = new URLSearchParams({ username, exact: 'true' });
    const response = await fetch(`${this.realmAdminUrl()}/users?${searchParams.toString()}`, {
      signal: AbortSignal.timeout(5_000),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status !== 200) {
      throw new KeycloakAdminError('Failed to query Keycloak user by username', response.status);
    }

    const users = (await response.json()) as Array<{ id?: string; username?: string }>;
    const user = users.find((entry) => entry.username === username);

    return user?.id ?? null;
  }

  private async replaceRealmRoles(accessToken: string, subject: string, role: UserRole) {
    const response = await fetch(`${this.realmAdminUrl()}/users/${subject}/role-mappings/realm`, {
      signal: AbortSignal.timeout(5_000),
      headers: this.jsonHeaders(accessToken),
    });
    if (response.status !== 200) {
      throw new KeycloakAdminError('Failed to query Keycloak realm roles', response.status);
    }
    const previous = ((await response.json()) as KeycloakRealmRole[]).filter((entry) => entry.name === 'admin' || entry.name === 'user');
    const target = await this.getRealmRole(accessToken, role);
    const targetWasPresent = previous.some((entry) => entry.name === role);
    try {
      // Keep the existing role until its replacement has been accepted.
      if (!targetWasPresent) {
        await this.writeRealmRoles(accessToken, subject, [target], 'POST');
      }
      await this.writeRealmRoles(accessToken, subject, previous.filter((entry) => entry.name !== role), 'DELETE');
    } catch (error) {
      await this.writeRealmRoles(accessToken, subject, previous, 'POST');
      if (!targetWasPresent) {
        await this.writeRealmRoles(accessToken, subject, [target], 'DELETE');
      }
      throw error;
    }
  }

  private async assignRealmRole(accessToken: string, subject: string, role: UserRole) {
    const realmRole = await this.getRealmRole(accessToken, role);
    await this.writeRealmRoles(accessToken, subject, [realmRole], 'POST');
  }

  private async writeRealmRoles(accessToken: string, subject: string, roles: KeycloakRealmRole[], method: 'POST' | 'DELETE') {
    if (roles.length === 0) {
      return;
    }
    const response = await fetch(`${this.realmAdminUrl()}/users/${subject}/role-mappings/realm`, {
      signal: AbortSignal.timeout(5_000),
      method,
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify(roles),
    });
    if (response.status !== 204) {
      throw new KeycloakAdminError(method === 'POST' ? 'Failed to assign Keycloak realm role' : 'Failed to clear Keycloak realm roles', response.status);
    }
  }

  private async getRealmRole(accessToken: string, role: UserRole): Promise<KeycloakRealmRole> {
    const response = await fetch(`${this.realmAdminUrl()}/roles/${role}`, {
      signal: AbortSignal.timeout(5_000),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status !== 200) {
      throw new KeycloakAdminError('Failed to resolve Keycloak realm role', response.status);
    }

    return (await response.json()) as KeycloakRealmRole;
  }

  private async getAccessToken() {
    const response = await fetch(`${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/token`, {
      signal: AbortSignal.timeout(5_000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
      }),
    });

    if (response.status !== 200) {
      throw new KeycloakAdminError('Failed to obtain Keycloak admin access token', response.status);
    }

    const payload = (await response.json()) as { access_token?: string };

    if (!payload.access_token) {
      throw new KeycloakAdminError('Keycloak admin token response missing access_token');
    }

    return payload.access_token;
  }

  private realmAdminUrl() {
    return `${this.baseUrl()}/admin/realms/${this.realm()}`;
  }

  private jsonHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private requireEnv(name: string) {
    const value = process.env[name]?.trim();

    if (!value) {
      throw new Error(`${name} is required`);
    }

    return value;
  }

  private baseUrl() {
    return this.requireEnv('KEYCLOAK_ADMIN_BASE_URL');
  }

  private clientId() {
    return this.requireEnv('KEYCLOAK_ADMIN_CLIENT_ID');
  }

  private clientSecret() {
    return this.requireEnv('KEYCLOAK_ADMIN_CLIENT_SECRET');
  }

  private realm() {
    return process.env.KEYCLOAK_REALM?.trim() || 'cyber-range';
  }
}
