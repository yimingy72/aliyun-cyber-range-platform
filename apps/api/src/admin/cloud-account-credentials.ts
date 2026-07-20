import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTED_CLOUD_CREDENTIAL_PREFIX = 'enc:cloud:v1:';

export function encryptCloudAccountCredential(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_CLOUD_CREDENTIAL_PREFIX}${Buffer.concat([iv, authTag, encrypted]).toString('base64url')}`;
}

export function decryptCloudAccountCredential(value: string) {
  if (!value.startsWith(ENCRYPTED_CLOUD_CREDENTIAL_PREFIX)) {
    // Contexts created before credential encryption remain readable during rollout.
    return value;
  }

  const payload = Buffer.from(value.slice(ENCRYPTED_CLOUD_CREDENTIAL_PREFIX.length), 'base64url');

  if (payload.length <= 28) {
    throw new Error('Cloud account credential payload is invalid.');
  }

  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', readKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function readKey() {
  const configured = process.env.CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY?.trim();

  if (!configured) {
    throw new Error('CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY is required before saving or reading cloud account credentials.');
  }

  return createHash('sha256').update(configured).digest();
}
