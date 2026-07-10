import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { UserRole, UserStatus } from './admin.repository';

const PASSWORD_HASH_SCHEME = 'scrypt';
const SESSION_TOKEN_VERSION = 'v1';
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'change-me';
const DEFAULT_ADMIN_SESSION_SECRET = 'dev-admin-token';

export type SessionUserProfile = {
  id: string;
  username: string;
  role: UserRole;
};

type SessionTokenPayload = {
  sub: string;
  fp: string;
};

type SessionFingerprintUser = {
  id: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  updatedAt: Date;
};

export function resolveSeededAdminCredentials() {
  return {
    id: 'admin',
    username: process.env.ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  };
}

export function resolveAdminSessionSecret() {
  return process.env.ADMIN_TOKEN?.trim() || DEFAULT_ADMIN_SESSION_SECRET;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const derivedKey = scryptSync(password, salt, 64).toString('base64url');

  return `${PASSWORD_HASH_SCHEME}.${salt}.${derivedKey}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [scheme, salt, expectedHash] = passwordHash.split('.');

  if (scheme !== PASSWORD_HASH_SCHEME || !salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(password, salt, 64).toString('base64url');

  return safeEqual(actualHash, expectedHash);
}

export function signSessionToken(user: SessionFingerprintUser, secret: string) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      fp: buildSessionFingerprint(user),
    } satisfies SessionTokenPayload),
    'utf8',
  ).toString('base64url');
  const signature = createSessionSignature(payload, secret);

  return `${SESSION_TOKEN_VERSION}.${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionTokenPayload | null {
  const [version, payload, signature] = token.split('.');

  if (version !== SESSION_TOKEN_VERSION || !payload || !signature) {
    return null;
  }

  const expectedSignature = createSessionSignature(payload, secret);

  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionTokenPayload>;

    if (
      typeof decoded.sub !== 'string' ||
      decoded.sub.length === 0 ||
      typeof decoded.fp !== 'string' ||
      decoded.fp.length === 0
    ) {
      return null;
    }

    return {
      sub: decoded.sub,
      fp: decoded.fp,
    };
  } catch {
    return null;
  }
}

export function hasValidSessionFingerprint(payload: SessionTokenPayload, user: SessionFingerprintUser) {
  return safeEqual(payload.fp, buildSessionFingerprint(user));
}

function createSessionSignature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function buildSessionFingerprint(user: SessionFingerprintUser) {
  return createHash('sha256')
    .update(user.passwordHash)
    .update('\0')
    .update(user.role)
    .update('\0')
    .update(user.status)
    .update('\0')
    .update(user.updatedAt.toISOString())
    .digest('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
