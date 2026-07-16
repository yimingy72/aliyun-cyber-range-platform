import { Injectable } from '@nestjs/common';

import type { UserRole, UserStatus } from './admin.repository';

type CreateKeycloakUserInput = {
  username: string;
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

class KeycloakAdminError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
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
  async createUser(input: CreateKeycloakUserInput): Promise<string> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.realmAdminUrl()}/users`, {
      method: 'POST',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({
        username: input.username,
        enabled: input.status === 'active',
        emailVerified: true,
        firstName: 'Platform',
        lastName: 'User',
        email: `${input.username}@example.local`,
        credentials: [{ type: 'password', value: input.password, temporary: false }],
        requiredActions: [],
      }),
    });

    if (response.status === 409) {
      throw new KeycloakAdminError('Username already exists', 409);
    }

    if (response.status !== 201) {
      throw new KeycloakAdminError('Failed to create Keycloak user', response.status);
    }

    const location = response.headers.get('location');
    const subject = location?.split('/').pop();

    if (!subject) {
      throw new KeycloakAdminError('Keycloak create user response missing subject');
    }

    await this.assignRealmRole(accessToken, subject, input.role);

    return subject;
  }

  async updateUserRole(input: UpdateKeycloakRoleInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    await this.replaceRealmRoles(accessToken, input.subject, input.role);
  }

  async updateUserStatus(input: UpdateKeycloakStatusInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.realmAdminUrl()}/users/${input.subject}`, {
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
      method: 'PUT',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({ type: 'password', value: input.password, temporary: false }),
    });

    if (response.status !== 204) {
      throw new KeycloakAdminError('Failed to reset Keycloak user password', response.status);
    }

    const requiredActionsResponse = await fetch(`${this.realmAdminUrl()}/users/${input.subject}`, {
      method: 'PUT',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({ requiredActions: [] }),
    });

    if (requiredActionsResponse.status !== 204) {
      throw new KeycloakAdminError('Failed to clear Keycloak required actions', requiredActionsResponse.status);
    }
  }

  async findUserSubjectByUsername(username: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const searchParams = new URLSearchParams({ username, exact: 'true' });
    const response = await fetch(`${this.realmAdminUrl()}/users?${searchParams.toString()}`, {
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
    const removableRoles = await Promise.all([
      this.getRealmRole(accessToken, 'admin'),
      this.getRealmRole(accessToken, 'user'),
    ]);
    const removeResponse = await fetch(`${this.realmAdminUrl()}/users/${subject}/role-mappings/realm`, {
      method: 'DELETE',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify(removableRoles),
    });

    if (removeResponse.status !== 204) {
      throw new KeycloakAdminError('Failed to clear Keycloak realm roles', removeResponse.status);
    }

    await this.assignRealmRole(accessToken, subject, role);
  }

  private async assignRealmRole(accessToken: string, subject: string, role: UserRole) {
    const realmRole = await this.getRealmRole(accessToken, role);
    const addResponse = await fetch(`${this.realmAdminUrl()}/users/${subject}/role-mappings/realm`, {
      method: 'POST',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify([realmRole]),
    });

    if (addResponse.status !== 204) {
      throw new KeycloakAdminError('Failed to assign Keycloak realm role', addResponse.status);
    }
  }

  private async getRealmRole(accessToken: string, role: UserRole): Promise<KeycloakRealmRole> {
    const response = await fetch(`${this.realmAdminUrl()}/roles/${role}`, {
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
