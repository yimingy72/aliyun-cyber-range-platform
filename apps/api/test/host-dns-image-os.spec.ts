import { resolveAliyunWindowsDnsHostImages, OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { assertTencentImagesAvailable } from '../src/provisioning/tencent-cloud-zone-instance-scheduler';
import * as tencent from '../src/admin/tencent-cloud-client';
import * as scheduler from '../src/provisioning/tencent-cloud-zone-instance-scheduler';

const runtimeConfig = { accessKeyId: 'fixture-ak', accessKeySecret: 'fixture-sk', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' };
const input = { hosts: [{ key: 'member-a', dns: {} },{ key: 'member-b', dns: {} },{ key: 'linux' }], hostImageIds: { 'member-a': 'm-windows','member-b': 'm-windows', linux: 'm-linux' }, fallbackImageId: 'm-fallback', runtimeConfig };
const windows = { TotalCount: 1, Images: { Image: [{ ImageId: 'm-windows', Status: 'Available', OSType: 'windows', Platform: 'Windows Server 2019' }] } };
afterEach(() => jest.restoreAllMocks());
it('avoids image metadata calls for an unchanged non-DNS topology', async () => {
  const fetch = jest.spyOn(global,'fetch');
  await expect(resolveAliyunWindowsDnsHostImages({ ...input, hosts: [{ key: 'linux' }] })).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
it('verifies exact Windows image OS once for shared DNS hosts using the frozen account', async () => {
  const fetch = jest.spyOn(global,'fetch').mockResolvedValue({ ok: true, json: async () => windows } as Response);
  await expect(resolveAliyunWindowsDnsHostImages(input)).resolves.toEqual({ 'member-a': true,'member-b': true });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = new URL(String(fetch.mock.calls[0][0]));
  expect(request.hostname).toBe('ecs.cn-hangzhou.aliyuncs.com');
  expect(request.searchParams.get('Action')).toBe('DescribeImages');
  expect(request.searchParams.get('ImageId')).toBe('m-windows');
  expect(request.searchParams.get('AccessKeyId')).toBe('fixture-ak');
  expect(request.searchParams.has('OSType')).toBe(false);
});
it.each([
  { OSType: 'linux', Platform: 'Ubuntu' },
  { OSType: undefined, Platform: 'Windows Server 2019' },
  { OSType: 'windows', Platform: 'Ubuntu' },
  { OSType: 'windows', Status: 'Unavailable' },
  { OSType: 'windows', ImageId: 'm-other' },
])('rejects mismatched OS or image identity before DNS rendering: %j', fields => {
  jest.spyOn(global,'fetch').mockResolvedValue({ ok: true, json: async () => ({ TotalCount: 1, Images: { Image: [{ ...windows.Images.Image[0], ...fields }] } }) } as Response);
  return expect(resolveAliyunWindowsDnsHostImages(input)).rejects.toThrow('officially identified Windows');
});
it.each([null, {}, { TotalCount: 0, Images: { Image: [] } }, { ...windows, TotalCount: 2 }, { TotalCount: 1, Images: { Image: windows.Images.Image.concat(windows.Images.Image) } }])('rejects incomplete Alibaba DescribeImages metadata: %j', payload => {
  jest.spyOn(global,'fetch').mockResolvedValue({ ok: true, json: async () => payload } as Response);
  return expect(resolveAliyunWindowsDnsHostImages(input)).rejects.toThrow('officially identified Windows');
});
it.each([
  ['Windows Server 2012 R2 Datacenter',true,true],
  ['Microsoft Windows Server 2022 Datacenter',true,true],
  ['Windows Server 2008 R2 Enterprise',true,false],
  ['Windows Server 2012 Datacenter',true,false],
  ['Ubuntu 22.04 LTS',false,false],
  ['Customized unknown OS',false,false],
] as const)('uses official Tencent OsName %s for DNS OS support rather than display name', async (OsName,isWindows,windowsUserDataSupported) => {
  jest.spyOn(tencent,'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PUBLIC_IMAGE', Architecture: 'x86_64', ImageSize: 50, SnapshotSet: null, OsName, ImageName: 'Windows Server 2022', ImageDescription: 'Windows' }] } as any);
  expect(await assertTencentImagesAvailable({ ...runtimeConfig, provider: 'tencent_cloud', defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1' },['img-fixture'])).toEqual({ 'img-fixture': { minimumSystemDiskSize: 50, architecture: 'x86_64', isWindows, windowsUserDataSupported } });
});
it('does not invent an OS from the user-editable Tencent name or description', async () => {
  jest.spyOn(tencent,'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PUBLIC_IMAGE', Architecture: 'x86_64', ImageSize: 50, SnapshotSet: null, ImageName: 'Windows Server 2022', ImageDescription: 'Windows' }] } as any);
  expect(await assertTencentImagesAvailable({ ...runtimeConfig, provider: 'tencent_cloud' },['img-fixture'])).toEqual({ 'img-fixture': { minimumSystemDiskSize: 50, architecture: 'x86_64' } });
});

function tencentDnsCaller() {
  const account = { ...runtimeConfig, provider: 'tencent_cloud' as const, accountUid: '100000000001', cloudAccountContextId: 'ctx-fixture', defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1' };
  const provisioner = new OpenTofuRangeProvisioner({ workspacesRootDir: '/tmp/dns-os-test-workspaces' });
  const plan = { resourceNamePrefix: 'fixture', entryHostKey: 'member', network: { vpcCidr: '10.0.0.0/16', secondaryVpcCidrs: [] }, networkZones: [{ key: 'z', name: 'LAN', cidr: '10.0.2.0/24' }],
    hostDefinitions: [{ key: 'member', name: 'Member', hostName: 'member', zoneKey: 'z', privateIp: '10.0.2.20', dns: { servers: ['10.0.1.10'], nicIds: ['member-nic'] } }], hostNetworkInterfaces: [{ hostKey: 'member', interfaces: [{ nicId: 'member-nic', deviceIndex: 0, zoneKey: 'z', privateIp: '10.0.2.20' }] }], bootstrapScripts: [], natGateways: [], eipDefinitions: [], securityGroupRules: [], aclDefinitions: [], snatEntries: [], dnatEntries: [], runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} } };
  const input = { rangeInstanceId: 'dns-os-member', compiledProvisionSpec: { hosts: [{ key: 'member', imageId: 'img-fixture' }] }, runtimeCredentials: { member: { username: 'Administrator', password: 'FixturePassword123!' } }, billingTags: { PlatformCreateJobId: 'job-fixture' }, expiresAt: '2100-01-01T00:00:00Z' };
  jest.spyOn(scheduler,'selectTencentHostInstanceTypes').mockResolvedValue({ member: { instanceType: 'S5.MEDIUM4', cpu: 2 } });
  return { account, provisioner, plan, input };
}
it.each([{ isWindows: false, windowsUserDataSupported: false },{}, { isWindows: true, windowsUserDataSupported: false }])('Tencent DNS caller refuses Linux, unknown and unsupported Windows even when username is Administrator: %j', async os => {
  const { account,provisioner,plan,input } = tencentDnsCaller();
  jest.spyOn(scheduler,'assertTencentImagesAvailable').mockResolvedValue({ 'img-fixture': { minimumSystemDiskSize: 50, architecture: 'x86_64', ...os } });
  await expect((provisioner as any).buildTencentVariables(input,plan,account,{ requireRuntimePasswords: true })).rejects.toThrow('officially identified Windows Server');
});
it('Tencent DNS caller renders Windows userdata from image metadata even when username is root', async () => {
  const { account,provisioner,plan,input } = tencentDnsCaller(); input.runtimeCredentials.member.username = 'root';
  jest.spyOn(scheduler,'assertTencentImagesAvailable').mockResolvedValue({ 'img-fixture': { minimumSystemDiskSize: 50, architecture: 'x86_64', isWindows: true, windowsUserDataSupported: true } });
  const result = await (provisioner as any).buildTencentVariables(input,plan,account,{ requireRuntimePasswords: true });
  expect(result.hosts[0].user_data).toMatch(/^<powershell>\n/);
});
