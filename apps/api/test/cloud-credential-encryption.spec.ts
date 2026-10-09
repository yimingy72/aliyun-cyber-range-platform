import { decryptCloudCredential, encryptCloudCredential, readCloudCredentialEncryptionKey } from '../src/admin/cloud-credential-encryption';

const binding = { provider: 'tencent_cloud' as const, accountUid: '100001', regionId: 'ap-shanghai', accessKeyId: 'synthetic-key-id' };
describe('Tencent credential encryption', () => {
  const previousKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  beforeEach(() => { process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32); });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  });
  it('uses randomized authenticated envelopes and restores the exact secret', () => {
    const first = encryptCloudCredential('synthetic-secret', binding, readCloudCredentialEncryptionKey());
    const second = encryptCloudCredential('synthetic-secret', binding, readCloudCredentialEncryptionKey());
    expect(first).not.toContain('synthetic-secret'); expect(first).not.toEqual(second);
    expect(decryptCloudCredential(first, binding)).toBe('synthetic-secret');
  });
  it.each(['provider', 'accountUid', 'regionId', 'accessKeyId'])('rejects a copied envelope with a different %s', (field) => {
    const value = encryptCloudCredential('synthetic-secret', binding, readCloudCredentialEncryptionKey());
    expect(() => decryptCloudCredential(value, { ...binding, [field]: 'different-source' })).toThrow('无法解密');
  });
  it('rejects tampering, plaintext Tencent credentials, and a changed encryption key without leaking values', () => {
    const value = encryptCloudCredential('synthetic-secret', binding, readCloudCredentialEncryptionKey());
    const parts = value.split('.'); parts[1] = 'A'.repeat(22);
    for (const invalid of [parts.join('.'), 'synthetic-secret', 'cloud-credential:v1:broken']) {
      try { decryptCloudCredential(invalid, binding); throw new Error('unexpected decryption'); }
      catch (error) { expect(String(error)).toContain('无法解密'); expect(String(error)).not.toContain(invalid); }
    }
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '34'.repeat(32);
    expect(() => decryptCloudCredential(value, binding)).toThrow('无法解密');
  });
  it.each([undefined, '', 'short', 'g'.repeat(64), '12'.repeat(31)])('rejects missing or invalid encryption keys', (key) => {
    if (key === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = key;
    expect(() => readCloudCredentialEncryptionKey()).toThrow('加密密钥未配置或格式无效');
  });
});
