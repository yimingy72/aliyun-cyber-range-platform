import type { IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';

import { PrismaClient, type UserRole } from '@aliyun-cyber-range/database/generated/client';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { OidcJwtVerifier } from './oidc-jwt-verifier';

const identityScopes = new Set(['openid', 'profile', 'email', 'address', 'phone', 'offline_access', 'roles', 'web-origins', 'acr', 'basic', 'mcp-access']);

export function hasExplicitPermissionScopes(scopes?: readonly string[]) {
  return scopes?.some(scope => !identityScopes.has(scope)) === true;
}

const prisma = new PrismaClient();
let oidcJwtVerifier: OidcJwtVerifier | null = null;

export const END_USER_SCOPES = [
  'templates:read',
  'templates:write',
  'templates:publish',
  'templates:delete',
  'images:read',
  'images:write',
  'ranges:read',
  'ranges:create',
  'ranges:write',
  'ranges:control',
  'ranges:destroy',
  'instances:read',
  'instances:create',
  'instances:destroy',
  'instances:control',
  'instances:credentials:read',
  'jobs:read',
];

export const ADMIN_SCOPES = [
  ...END_USER_SCOPES,
  'users:read',
  'users:write',
  'billing:read',
  'billing:sync',
  'settings:read',
  'settings:write',
];

export async function authenticateRequest(request: IncomingMessage): Promise<AuthInfo | null> {
  const token = readBearerToken(request.headers.authorization);

  if (!token) {
    return null;
  }

  if (looksLikeJwt(token)) {
    const oidcAuth = await authenticateOidcToken(token);

    if (oidcAuth) {
      return oidcAuth;
    }
  }
  if (process.env.PLATFORM_AUTH_MODE === 'keycloak') {
    try {
      const grant = await (await import('./oauth-broker')).unwrapBrokerAccess(token);
      if (grant) return await authenticateUnified(grant.token, await getOidcJwtVerifier().verifyAccessToken(grant.token), grant, token);
    } catch {
      return null;
    }
  }

  return null;
}

async function authenticateOidcToken(token: string): Promise<AuthInfo | null> {
  try {
    const claims = await getOidcJwtVerifier().verifyAccessToken(token);
    if (!claims.authorizedParty) return null;
    if (process.env.PLATFORM_AUTH_MODE === 'keycloak') return await authenticateUnified(token, claims);
    const user = await prisma.platformUser.findFirst({
      where: {
        oidcIssuer: claims.issuer,
        oidcSubject: claims.subject,
        status: 'active',
      },
    });

    if (!user) {
      return null;
    }

    return {
      token,
      clientId: claims.authorizedParty,
      scopes: scopesForRole(user.role, claims.scopes),
      extra: {
        userId: user.id,
        username: user.username,
        role: user.role,
        cloudWorkspaceId: user.cloudWorkspaceId,
        isPlatformManager: user.isPlatformManager,
        authType: 'oidc',
        businessScopeRestricted: hasExplicitPermissionScopes(claims.scopes),
        issuer: claims.issuer,
        subject: claims.subject,
      },
    };
  } catch {
    return null;
  }
}

function getOidcJwtVerifier() {
  if (!oidcJwtVerifier) {
    oidcJwtVerifier = new OidcJwtVerifier(process.env.PLATFORM_AUTH_MODE === 'keycloak' ? 'cyber-range-mcp' : undefined);
  }

  return oidcJwtVerifier;
}

async function authenticateUnified(
  token: string,
  claims: Awaited<ReturnType<OidcJwtVerifier['verifyAccessToken']>>,
  broker?: { client: string; scope?: string[] },
  publicToken = token,
): Promise<AuthInfo | null> {
  const clientId = process.env.OIDC_UNIFIED_CLIENT_ID?.trim() || 'cyber-range';
  const clientSecret = process.env.OIDC_UNIFIED_CLIENT_SECRET?.trim();
  const endpoint = process.env.OIDC_TOKEN_ENDPOINT?.trim();
  const api = process.env.PLATFORM_API_BASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.OIDC_MCP_DELEGATION_KEY;
  const allowedClients = [clientId, ...(process.env.OIDC_MCP_EXTERNAL_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean)];
  if (!key || key.length < 32 || !endpoint || !api || !clientSecret || !claims.authorizedParty ||
      !allowedClients.includes(claims.authorizedParty) || claims.audience.includes('cyber-range-web') ||
      !claims.scopes?.includes('mcp-access')) return null;

  const response = await fetch(endpoint + '/introspect', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) return null;
  const status = await response.json();
  if (status.active !== true || status.sub !== claims.subject) return null;
  const scopes = broker?.scope
    ? broker.scope.filter(scope => !hasExplicitPermissionScopes(claims.scopes) || claims.scopes!.includes(scope))
    : claims.scopes;
  if (!scopes?.length) return null;
  const authorizedParty = broker?.client || claims.authorizedParty;
  const payload = Buffer.from(JSON.stringify({
    aud: 'cyber-range-api-internal', issuer: claims.issuer, subject: claims.subject,
    authorizedParty, scopes, exp: Math.floor(Date.now() / 1000) + 15,
  })).toString('base64url');
  const message = 'mcp-v1.' + payload;
  const delegation = message + '.' + createHmac('sha256', key).update(message).digest('base64url');
  const session = await fetch(api + '/admin/session', {
    headers: { Authorization: 'Bearer ' + delegation }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!session.ok) return null;
  const user = await session.json();
  if ((user.role !== 'user' && user.role !== 'admin') || typeof user.id !== 'string') return null;
  return {
    token: publicToken, clientId: authorizedParty,
    scopes: scopesForRole(user.role, scopes).filter(scope => !scope.startsWith('users:')),
    extra: { userId: user.id, role: user.role, cloudWorkspaceId: user.cloudWorkspaceId, isPlatformManager: user.isPlatformManager, platformDelegation: delegation },
  };
}

function readBearerToken(authorizationHeader?: string) {
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader ?? '');
  return match?.[1] ?? null;
}

function looksLikeJwt(token: string) {
  return token.split('.').length === 3;
}

export function scopesForRole(role: UserRole, tokenScopes?: string[]) {
  const roleScopes = role === 'admin' ? ADMIN_SCOPES : END_USER_SCOPES;
  // Existing Keycloak clients use identity scopes; explicit business scopes only narrow access.
  return hasExplicitPermissionScopes(tokenScopes) ? roleScopes.filter(scope => tokenScopes!.includes(scope)) : [...roleScopes];
}
