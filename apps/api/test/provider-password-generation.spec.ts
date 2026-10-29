import crypto = require('node:crypto');
import * as passwords from '../src/admin/ecs-password-generator';
import * as imagePassword from '../src/admin/platform-image-password';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { validateAliyunEcsPassword, validateTencentCvmPassword } from '@aliyun-cyber-range/scenario-runtime/compiled';

const legacyAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}:,.?';
function forceLegacyUnderscores() {
  // Make this regression deterministic: the legacy generator must select '_' in every filler slot.
  jest.spyOn(crypto, 'randomInt').mockImplementation(((min: number, max: number) =>
    max === legacyAlphabet.length ? legacyAlphabet.indexOf('_') : min) as typeof crypto.randomInt);
}
afterEach(() => jest.restoreAllMocks());

it('keeps the Alibaba alphabet while generating Tencent passwords from its creation-safe subset', () => {
  forceLegacyUnderscores();
  const ali = passwords.generateCloudInstancePassword('alibaba_cloud');
  expect(ali).toContain('_');
  expect(ali).toBe(passwords.generateAliyunEcsPassword());
  expect(validateAliyunEcsPassword(ali).valid).toBe(true);
  for (const length of [undefined, Number.NaN, 8, 12, 30, 40]) {
    const tencent = passwords.generateCloudInstancePassword('tencent_cloud', length);
    expect(tencent).not.toMatch(/[_<>]/);
    expect(tencent).not.toMatch(/administrator/i);
    expect(validateTencentCvmPassword(tencent, { windows: true }).valid).toBe(true);
  }
});

it('regenerates the rare Windows-username collision instead of randomly failing later', () => {
  const alphabet = legacyAlphabet.replace('_', '');
  const picks = [0, 0, 0, ...Array.from('Administrator', character => alphabet.indexOf(character)),
    ...Array.from({ length: 15 }, (_, index) => 15 - index)];
  expect(picks.every(index => index >= 0)).toBe(true);
  const random = jest.spyOn(crypto, 'randomInt').mockImplementation(((min: number) => picks.shift() ?? min) as typeof crypto.randomInt);
  const password = passwords.generateCloudInstancePassword('tencent_cloud');
  expect(random.mock.calls.length).toBeGreaterThan(31);
  expect(password).not.toMatch(/administrator/i);
  expect(validateTencentCvmPassword(password, { windows: true }).valid).toBe(true);
});

it.each(['alibaba_cloud', 'tencent_cloud'] as const)('uses frozen %s provider for new range hosts but never changes existing credentials', async provider => {
  forceLegacyUnderscores();
  const generate = jest.spyOn(passwords, 'generateCloudInstancePassword');
  const service = new RangeInstancesService({} as any, {} as any, {} as any, {} as any, {} as any);
  const previous = { old: { username: 'root', password: 'Frozen_password123!' } };
  const result = await (service as any).resolveRuntimeCredentials({ hosts: [{ key: 'old' }, { key: 'new' }] }, provider, previous);
  expect(result.old).toEqual(previous.old);
  expect(generate).toHaveBeenCalledWith(provider);
  expect(generate).toHaveBeenCalledTimes(1);
  if (provider === 'tencent_cloud') {
    expect(result.new.password).not.toMatch(/[_<>]/);
    expect(validateTencentCvmPassword(result.new.password, { windows: true }).valid).toBe(true);
  } else expect(result.new.password).toContain('_');
});

it.each(['alibaba_cloud', 'tencent_cloud'] as const)('uses the source %s account when generating packed-image defaults', async provider => {
  forceLegacyUnderscores();
  const generate = jest.spyOn(passwords, 'generateCloudInstancePassword');
  const encrypt = jest.spyOn(imagePassword, 'encryptPlatformImageDefaultPassword').mockImplementation(value => `encrypted:${value}`);
  const context = { provider, cloudAccountContextId: 'context', accountUid: '100001', accountUidResolved: true,
    defaultRegion: provider === 'tencent_cloud' ? 'ap-shanghai' : 'cn-shanghai', accessKeyId: 'synthetic', accessKeySecret: 'synthetic' };
  const instance = { id: 'range', cloudProvider: provider, instanceMode: 'range', status: 'running', ownerUserId: 'owner',
    runtimeTopologyGraph: { nodes: [{ id: 'host', kind: 'ecs' }] }, resourceSummary: { mode: 'opentofu', hostIds: { host: provider === 'tencent_cloud' ? 'ins-fixture' : 'i-fixture' },
      executionContext: { provider, cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: context.accountUid, regionId: context.defaultRegion } } };
  const packed = { begin: jest.fn().mockRejectedValue(new Error('PACK_BOUNDARY')) };
  const service = new RangeInstanceNodeActionsService({ getRangeInstanceById: async () => instance, listProvisionJobs: async () => [] } as any,
    { getAccountContextById: async () => context } as any, packed as any);
  await expect(service.run('range', 'host', 'pack-image', {}, { id: 'owner', role: 'user' })).rejects.toThrow('PACK_BOUNDARY');
  expect(generate).toHaveBeenCalledWith(provider);
  const generated = encrypt.mock.calls[0][0]!;
  if (provider === 'tencent_cloud') {
    expect(generated).not.toMatch(/[_<>]/);
    expect(validateTencentCvmPassword(generated, { windows: true }).valid).toBe(true);
  } else expect(generated).toContain('_');
});
