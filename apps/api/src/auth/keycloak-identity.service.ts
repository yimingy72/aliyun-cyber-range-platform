import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

type Configuration = {
  clientId: string;
  clientSecret: string;
  clientUuid: string;
  tokenUrl: string;
  adminUrl: string;
  workspaces: Record<string, string>;
};

export function usesKeycloakRoles() {
  return process.env.PLATFORM_AUTH_MODE === 'keycloak';
}

@Injectable()
export class KeycloakIdentityService {
  private serviceToken?: { token: string; expires: number };

  async resolve(subject: string, browserToken?: string) {
    const config = this.configuration();
    if (browserToken) {
      const status = await this.post(config, config.tokenUrl + '/introspect', { token: browserToken });
      if (status.active !== true || status.sub !== subject) throw new UnauthorizedException('Keycloak session is inactive');
    }
    const token = await this.getServiceToken(config);
    const path = config.adminUrl + '/users/' + encodeURIComponent(subject);
    const account = await this.get(path, token);
    if (account.id !== subject || account.enabled !== true || typeof account.username !== 'string') {
      throw new UnauthorizedException('Keycloak account is inactive');
    }
    const [roles, groups] = await Promise.all([
      this.get(path + '/role-mappings/clients/' + encodeURIComponent(config.clientUuid) + '/composite', token),
      this.get(path + '/groups?first=0&max=101&briefRepresentation=true', token),
    ]);
    if (!Array.isArray(roles) || !Array.isArray(groups) || groups.length > 100) {
      throw new ForbiddenException('Keycloak role or workspace assignment is invalid');
    }
    const role = roles.some(entry => entry.name === 'admin') ? 'admin'
      : roles.some(entry => entry.name === 'user') ? 'user' : null;
    if (!role) throw new ForbiddenException('No cyber-range client role is assigned');
    const workspaceIds = [...new Set(groups.flatMap(group => (
      typeof group.id === 'string' && Object.hasOwn(config.workspaces, group.id) ? [config.workspaces[group.id]] : []
    )))];
    return { username: account.username as string, role, workspaceIds, platformOperator: role === 'admin' && roles.some(entry => entry.name === 'platform-operator') } as const;
  }

  private async getServiceToken(config: Configuration) {
    if (this.serviceToken && this.serviceToken.expires > Date.now()) return this.serviceToken.token;
    const body = await this.post(config, config.tokenUrl, { grant_type: 'client_credentials' });
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new ServiceUnavailableException('Keycloak identity lookup is unavailable');
    }
    this.serviceToken = { token: body.access_token, expires: Date.now() + Math.max(0, body.expires_in - 10) * 1000 };
    return this.serviceToken.token;
  }

  private post(config: Configuration, url: string, data: Record<string, string>) {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...data, client_id: config.clientId, client_secret: config.clientSecret }),
    });
  }

  private get(url: string, token: string) {
    return this.request(url, { headers: { Authorization: 'Bearer ' + token } }, true);
  }

  private async request(url: string, init: RequestInit, userLookup = false) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ServiceUnavailableException('Keycloak identity lookup is unavailable');
    }
    if (userLookup && response.status === 404) throw new UnauthorizedException('Keycloak identity does not exist');
    if (!response.ok) throw new ServiceUnavailableException('Keycloak identity lookup is unavailable');
    return response.json();
  }

  private configuration(): Configuration {
    const clientId = process.env.OIDC_UNIFIED_CLIENT_ID?.trim() || 'cyber-range';
    const clientSecret = process.env.OIDC_UNIFIED_CLIENT_SECRET?.trim();
    const clientUuid = process.env.OIDC_UNIFIED_CLIENT_UUID?.trim();
    const tokenUrl = process.env.OIDC_TOKEN_ENDPOINT?.trim();
    const base = process.env.KEYCLOAK_ADMIN_BASE_URL?.trim().replace(/\/$/, '');
    const realm = process.env.KEYCLOAK_REALM?.trim() || 'cyber-range';
    try {
      const workspaces: unknown = JSON.parse(process.env.OIDC_WORKSPACE_GROUP_MAP || '{}');
      if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces) ||
          Object.entries(workspaces).some(([group, id]) => !group || typeof id !== 'string' || !id)) throw new Error();
      if (!clientSecret || !clientUuid || !tokenUrl || !base) throw new Error();
      return { clientId, clientSecret, clientUuid, tokenUrl, adminUrl: base + '/admin/realms/' + encodeURIComponent(realm), workspaces: workspaces as Record<string, string> };
    } catch {
      throw new ServiceUnavailableException('Keycloak identity configuration is incomplete');
    }
  }
}
