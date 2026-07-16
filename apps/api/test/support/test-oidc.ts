import { createSign, generateKeyPairSync } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';

import { OidcJwtVerifier } from '../../src/admin/oidc-jwt-verifier';
import type { AdminRepository } from '../../src/admin/admin.repository';
import { PrismaService } from '../../src/database/prisma.service';

const TEST_OIDC_ISSUER = 'https://test-issuer.example/realms/cyber-range';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

type TestClaims = {
  issuer: string;
  subject: string;
  audience: string[];
};

export function overrideTestOidc(moduleBuilder: TestingModuleBuilder) {
  return moduleBuilder.overrideProvider(OidcJwtVerifier).useValue({
    verifyAccessToken: async (token: string): Promise<TestClaims> => decodeTestToken(token),
  });
}

export async function loginAsRepositoryUser(repository: AdminRepository, username: string) {
  let user = await repository.getPlatformUserByUsername(username);

  if (!user && username === process.env.ADMIN_USERNAME?.trim()) {
    user = await repository.createPlatformUser({
      id: username,
      username,
      passwordHash: 'unused',
      role: 'admin',
      status: 'active',
    });
  }

  if (!user) {
    throw new Error(`Platform user not found: ${username}`);
  }

  const subject = `${user.id}-oidc`;

  await repository.updatePlatformUser(user.id, {
    oidcIssuer: TEST_OIDC_ISSUER,
    oidcSubject: subject,
  });

  return signTestToken(subject);
}

export async function loginAsPrismaUser(app: INestApplication, username: string) {
  const prisma = app.get(PrismaService);
  const user = await prisma.platformUser.findUnique({ where: { username } });

  if (!user) {
    throw new Error(`Platform user not found: ${username}`);
  }

  const subject = `${user.id}-oidc`;

  await prisma.platformUser.update({
    where: { id: user.id },
    data: {
      oidcIssuer: TEST_OIDC_ISSUER,
      oidcSubject: subject,
    },
  });

  return signTestToken(subject);
}

function signTestToken(subject: string) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const encodedPayload = encodeSegment({
    iss: TEST_OIDC_ISSUER,
    sub: subject,
    aud: 'platform-api',
    exp: now + 3600,
    iat: now,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function decodeTestToken(token: string): TestClaims {
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('OIDC token is malformed');
  }

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
    iss?: string;
    sub?: string;
    aud?: string | string[];
  };

  if (payload.iss !== TEST_OIDC_ISSUER || !payload.sub) {
    throw new Error('OIDC token issuer or subject is invalid');
  }

  return {
    issuer: payload.iss,
    subject: payload.sub,
    audience: Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [],
  };
}

function encodeSegment(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
