import { ConflictException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PackedImageArtifactRecord } from './admin.repository';
import { readCloudCredentialEncryptionKey } from './cloud-credential-encryption';

const PREFIX = 'packed-asset:v1:';
type Identity = Pick<PackedImageArtifactRecord, 'id' | 'cloudProvider' | 'cloudWorkspaceId' | 'cloudAccountContextId' | 'cloudAccountUid' | 'regionId'
  | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'sourceInstanceId' | 'sourceDiskIds'>;
export type PackedImageAssetConfig = { displayName: string; defaultHostName: string | null; defaultPassword: string | null; description: string | null };

function binding(identity: Identity) {
  return Buffer.from(JSON.stringify([identity.id, identity.cloudProvider ?? 'alibaba_cloud', identity.cloudWorkspaceId ?? 'legacy-unbound',
    identity.cloudAccountContextId, identity.cloudAccountUid, identity.regionId, identity.ownerUserId, identity.sourceRangeInstanceId,
    identity.sourceHostKey, identity.sourceInstanceId, [...identity.sourceDiskIds].sort()]));
}

export function encryptPackedImageAssetConfig(identity: Identity, config: PackedImageAssetConfig): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readCloudCredentialEncryptionKey(), iv);
  cipher.setAAD(binding(identity));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

export function readPackedImageAssetConfig(identity: Identity, ciphertext: string | null | undefined): PackedImageAssetConfig | null {
  if (ciphertext == null) return null;
  try {
    if (!ciphertext.startsWith(PREFIX)) throw new Error('Missing asset configuration envelope');
    const parts = ciphertext.slice(PREFIX.length).split('.');
    if (parts.length !== 3 || parts.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid envelope');
    const [iv, tag, encrypted] = parts.map(value => Buffer.from(value, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error('Invalid envelope lengths');
    const decipher = createDecipheriv('aes-256-gcm', readCloudCredentialEncryptionKey(), iv);
    decipher.setAAD(binding(identity));
    decipher.setAuthTag(tag);
    const config: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration');
    const value = config as PackedImageAssetConfig;
    if (typeof value.displayName !== 'string' || !value.displayName.trim()
      || ['defaultHostName', 'defaultPassword', 'description'].some(key => value[key as keyof PackedImageAssetConfig] !== null && typeof value[key as keyof PackedImageAssetConfig] !== 'string')
      || value.defaultPassword !== null && !value.defaultPassword.startsWith('enc:v1:')) throw new Error('Invalid configuration fields');
    return value;
  } catch {
    throw new ConflictException('打包资产配置无法验证或解密，请检查原加密密钥；恢复材料已保留。');
  }
}
