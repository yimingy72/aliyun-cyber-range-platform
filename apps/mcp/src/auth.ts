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

  const staticAuth = authenticateStaticToken(token);

  if (staticAuth) {
    return staticAuth;
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
      clientId: user.id,
      scopes: scopesForRole(user.role),
      extra: {
        username: user.username,
        role: user.role,
        authType: 'oidc',
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

function authenticateStaticToken(token: string): AuthInfo | null {
  const configuredToken = process.env.MCP_STATIC_BEARER_TOKEN?.trim();

  if (!configuredToken || token !== configuredToken) {
    return null;
  }

  return {
    token,
    clientId: process.env.MCP_STATIC_CLIENT_ID?.trim() || 'mcp-static-client',
    scopes: parseStaticScopes(),
    extra: {
      username: process.env.MCP_STATIC_USERNAME?.trim() || 'mcp-static',
      role: 'admin',
      mode: 'static',
      authType: 'static',
    },
  };
}

function readBearerToken(authorizationHeader?: string) {
  const [scheme, token] = (authorizationHeader ?? '').split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

function looksLikeJwt(token: string) {
  return token.split('.').length === 3;
}

function scopesForRole(role: UserRole) {
  if (role === 'admin') {
    return [...ADMIN_SCOPES];
  }

  return [...END_USER_SCOPES];
}

function parseStaticScopes() {
  const configured = process.env.MCP_STATIC_SCOPES?.trim();

  if (!configured) {
    return [...ADMIN_SCOPES];
  }

  return configured
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
