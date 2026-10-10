import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const PREFIX = 'cloud-credential:v1:';
export type CloudCredentialBinding = {
  provider: 'alibaba_cloud' | 'tencent_cloud';
  accountUid: string;
  regionId: string;
  accessKeyId: string;
};

export function readCloudCredentialEncryptionKey(): Buffer {
  const value = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new BadRequestException('腾讯云凭据加密密钥未配置或格式无效，请配置 CLOUD_CREDENTIALS_ENCRYPTION_KEY 后重试。');
  }
  return Buffer.from(value, 'hex');
}

function bindingBytes(binding: CloudCredentialBinding) {
  return Buffer.from(JSON.stringify([binding.provider, binding.accountUid, binding.regionId, binding.accessKeyId]));
}

export function encryptCloudCredential(secret: string, binding: CloudCredentialBinding, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(bindingBytes(binding));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ciphertext].map((item) => item.toString('base64url')).join('.');
}

export function decryptCloudCredential(value: string, binding: CloudCredentialBinding): string {
  const key = readCloudCredentialEncryptionKey();
  try {
    if (!value.startsWith(PREFIX)) throw new Error('Missing credential envelope');
    const parts = value.slice(PREFIX.length).split('.');
    if (parts.length !== 3 || parts.some((item) => !/^[A-Za-z0-9_-]+$/.test(item))) throw new Error('Invalid envelope');
    const [iv, tag, ciphertext] = parts.map((item) => Buffer.from(item, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('Invalid envelope lengths');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(bindingBytes(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new BadRequestException('腾讯云凭据无法解密，请检查加密密钥或重新保存该账号。');
  }
}
