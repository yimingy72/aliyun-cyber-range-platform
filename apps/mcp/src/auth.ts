import type { IncomingMessage } from 'node:http';

import { PrismaClient, type UserRole } from '@aliyun-cyber-range/database/generated/client';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { OidcJwtVerifier } from './oidc-jwt-verifier';

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

  return null;
}

async function authenticateOidcToken(token: string): Promise<AuthInfo | null> {
  try {
    const claims = await getOidcJwtVerifier().verifyAccessToken(token);
    if (!claims.authorizedParty) return null;
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
        businessScopeRestricted: claims.scopes?.some(scope => scope.includes(':')) === true,
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
    oidcJwtVerifier = new OidcJwtVerifier();
  }

  return oidcJwtVerifier;
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
  const businessScopes = tokenScopes?.filter(scope => scope.includes(':'));
  return businessScopes?.length ? roleScopes.filter(scope => businessScopes.includes(scope)) : [...roleScopes];
}
