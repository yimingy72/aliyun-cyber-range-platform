import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTED_PASSWORD_PREFIX = 'enc:v1:';

export function encryptPlatformImageDefaultPassword(value: string | null | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readKey(), iv);
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PASSWORD_PREFIX}${Buffer.concat([iv, authTag, encrypted]).toString('base64url')}`;
}

export function decryptPlatformImageDefaultPassword(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (!value.startsWith(ENCRYPTED_PASSWORD_PREFIX)) {
    return value;
  }

  const payload = Buffer.from(value.slice(ENCRYPTED_PASSWORD_PREFIX.length), 'base64url');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', readKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function readKey() {
  const configured = process.env.PLATFORM_IMAGE_SECRET_KEY?.trim();

  if (!configured) {
    throw new Error('PLATFORM_IMAGE_SECRET_KEY is required before saving an image default password.');
  }

  return createHash('sha256').update(configured).digest();
}
