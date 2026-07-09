import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { UserRole } from './admin.repository';

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

export function signSessionToken(userId: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({ sub: userId } satisfies SessionTokenPayload), 'utf8').toString(
    'base64url',
  );
  const signature = createSessionSignature(payload, secret);

  return `${SESSION_TOKEN_VERSION}.${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionTokenPayload | null {
  if (token === secret) {
    // ponytail: compatibility shim for callers still sending the old fixed token; remove once every caller logs in first.
    return { sub: 'admin' };
  }

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

    if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
      return null;
    }

    return { sub: decoded.sub };
  } catch {
    return null;
  }
}

function createSessionSignature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
