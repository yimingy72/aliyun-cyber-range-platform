import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import * as passwords from '../src/admin/ecs-password-generator';
import { validateTencentCvmPassword } from '@aliyun-cyber-range/scenario-runtime/compiled';
import * as scheduler from '../src/provisioning/tencent-cloud-zone-instance-scheduler';

function fixture(windows = false) {
  const repository = createMemoryAdminRepository();
  const account = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'context-tencent', accountUid: '100000000001', accountUidResolved: true,
    defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '' };
  const image = { id: 'asset-tencent', enabled: true, visibility: 'platform', provider: account.provider, accountUid: account.accountUid,
    regionId: account.defaultRegion, sourceSnapshotId: 'source-tencent', imageId: 'img-fixture', displayName: 'Training image', defaultHostName: null as string | null };
  jest.spyOn(repository, 'getPlatformImageAssetById').mockImplementation(async () => ({ ...image }) as never);
  // Deliberately stale catalog OS: live provider metadata is the final login authority.
  jest.spyOn(repository, 'getImageSnapshotById').mockResolvedValue({ id: 'source-tencent', isAvailable: true, osType: 'linux' } as never);
  const metadata = jest.spyOn(scheduler, 'assertTencentImagesAvailable').mockResolvedValue({ 'img-fixture': { minimumSystemDiskSize: 50, architecture: 'x86_64', isWindows: windows } });
  const config = { getExecutionAccountContext: jest.fn().mockImplementation(async () => ({ ...account })),
    getInstanceTypeAvailabilityInContext: jest.fn().mockResolvedValue({ exactAvailable: true, matches: [{ instanceTypeId: 'S5.MEDIUM4', architecture: 'X86_64' }], warning: null }) };
  const profile = { id: 'network-tencent', provider: account.provider, cloudAccountUid: account.accountUid, regionId: account.defaultRegion,
    zoneId: account.defaultZoneId, vpcId: 'vpc-fixture', vpcCidr: '10.200.0.0/16', vswitchIds: ['subnet-fixture'],
    vswitchCidrs: ['10.200.1.0/24'], securityGroupId: 'sg-fixture' };
  const network = { ensureDefaultProfile: jest.fn().mockResolvedValue(profile), allocateVswitch: SingleInstanceNetworkService.prototype.allocateVswitch };
  const worker = { dispatch: jest.fn() };
  const service = new SingleInstancesService(repository, config as any, network as any, {} as any, worker as any, {} as any);
  const input = { name: 'tencent-single', platformImageAssetId: image.id, cpu: 2, memory: 4, quantity: 1,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  return { repository, account, image, metadata, config, network, worker, service, input };
}
afterEach(() => jest.restoreAllMocks());

it.each(['abcdefgh', 'Abcd 1234!', '/Valid1234!', 'Abcdefgh1234_', 'Abcdefgh1234<', 'Abcdefgh1234>'])('rejects invalid Tencent password %s before network creation and records', async password => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) await expect(f.service.launch({ ...f.input, password }, 'owner')).rejects.toThrow('腾讯云 CVM');
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
  expect(f.worker.dispatch).not.toHaveBeenCalled();
  expect(await f.repository.listProvisionJobs()).toEqual([]);
  expect(await f.repository.listRangeInstances()).toEqual([]);
});

it('validates Windows password against live image OS before a shared network is created', async () => {
  const f = fixture(true);
  await expect(f.service.launch({ ...f.input, password: 'abcdefgh1' }, 'owner')).rejects.toThrow('password');
  expect(f.metadata).toHaveBeenCalled();
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
  expect(await f.repository.listProvisionJobs()).toEqual([]);
});

it.each([['request', 'windows-host-long'], ['default', 'windows-host-long'], ['indexed', 'windows-host1']])('rejects the %s Windows hostname before creating a network', async (source, hostName) => {
  const f = fixture(true);
  if (source === 'default') f.image.defaultHostName = hostName;
  await expect(f.service.launch({ ...f.input, ...(source === 'default' ? {} : { hostName }), quantity: source === 'indexed' ? 2 : 1 }, 'owner')).rejects.toThrow('host name');
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
  expect(await f.repository.listProvisionJobs()).toEqual([]);
});

it('rejects unsupported Tencent disk sizes before network creation', async () => {
  const f = fixture();
  await expect(f.service.launch({ ...f.input, systemDiskSize: 1025 }, 'owner')).rejects.toThrow('1024');
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
});

it('accepts Tencent Linux two-class passwords and 60-character hostnames', async () => {
  const f = fixture();
  const result = await f.service.launch({ ...f.input, password: 'abcdefgh1', hostName: 'a'.repeat(60) }, 'owner');
  expect(result.batch.quantity).toBe(1);
  const [instance] = await f.repository.listRangeInstances();
  expect(instance.singleInstanceConfig?.hostName).toHaveLength(60);
  expect(instance.runtimeCredentials?.['single-ecs-1']).toEqual({ username: 'root', password: 'abcdefgh1' });
});

it('uses verified Tencent Windows metadata for the frozen Administrator login', async () => {
  const f = fixture(true);
  await f.service.launch({ ...f.input, password: 'ValidPassword123!' }, 'owner');
  const [instance] = await f.repository.listRangeInstances();
  expect(instance.runtimeCredentials?.['single-ecs-1']).toEqual({ username: 'Administrator', password: 'ValidPassword123!' });
});

it('rejects an account switch during availability lookup without creating a network or records', async () => {
  const f = fixture();
  f.config.getExecutionAccountContext.mockResolvedValueOnce(f.account).mockResolvedValue({ ...f.account, provider: 'alibaba_cloud' } as any);
  await expect(f.service.launch(f.input, 'owner')).rejects.toThrow('云账号配置');
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
  expect(await f.repository.listProvisionJobs()).toEqual([]);
});

it('retains an empty intake after failed image reads and allows a later verified retry', async () => {
  const f = fixture();
  f.metadata.mockRejectedValueOnce(new Error('image lookup failed'));
  await expect(f.service.launch(f.input, 'owner')).rejects.toThrow('image lookup failed');
  expect(f.network.ensureDefaultProfile).not.toHaveBeenCalled();
  expect(await f.repository.listProvisionJobs()).toEqual([]);
  await expect(f.service.launch(f.input, 'owner')).resolves.toMatchObject({ batch: { quantity: 1 } });
  expect(await f.repository.listProvisionJobs()).toHaveLength(1);
});

it('generates provider-safe passwords for both preflight and newly persisted Tencent members', async () => {
  const generated = jest.spyOn(passwords, 'generateCloudInstancePassword');
  const f = fixture(true);
  await f.service.launch({ ...f.input, quantity: 2 }, 'owner');
  expect(generated).toHaveBeenCalledTimes(3);
  expect(generated.mock.calls.every(([provider]) => provider === 'tencent_cloud')).toBe(true);
  const members = await f.repository.listRangeInstances();
  expect(members).toHaveLength(2);
  for (const member of members) {
    const credential = Object.values(member.runtimeCredentials!)[0];
    expect(validateTencentCvmPassword(credential.password, { windows: true }).valid).toBe(true);
    expect(credential.password).not.toMatch(/[_<>]/);
  }
});
