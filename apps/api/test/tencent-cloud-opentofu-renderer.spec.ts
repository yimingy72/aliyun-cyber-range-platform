import {
  TencentCloudOpenTofuRenderer,
  type TencentCloudSingleInstanceBatchRendererInput,
} from '../src/provisioning/renderers/tencent-cloud-opentofu-renderer';

function input(): TencentCloudSingleInstanceBatchRendererInput {
  return {
    batchId: 'batch-1', cloudAccountUid: '100000000001', region: 'ap-shanghai', zoneId: 'ap-shanghai-2',
    vpcId: 'vpc-fixture', securityGroupId: 'sg-fixture',
    members: [
      { rangeInstanceId: 'member-1', ownerUserId: 'owner-1', creationIntentId: 'intent-1', instanceName: 'first', instanceType: 'S5.MEDIUM4', imageId: 'img-fixture', subnetId: 'subnet-first', password: 'FirstFixture123!' },
      { rangeInstanceId: 'member-2', ownerUserId: 'owner-2', creationIntentId: 'intent-2', instanceName: 'second', instanceType: 'S5.MEDIUM4', imageId: 'img-fixture', subnetId: 'subnet-second', password: 'SecondFixture123!', internetMaxBandwidthOut: 5 },
    ],
  };
}

describe('TencentCloudOpenTofuRenderer', () => {
  const renderer = new TencentCloudOpenTofuRenderer();

  it('keeps frozen account, per-user ownership, network assignments and secrets separate', () => {
    const rendered = renderer.render(input());
    expect(rendered).toMatchObject({ batch_id: 'batch-1', cloud_account_uid: '100000000001', region: 'ap-shanghai', zone_id: 'ap-shanghai-2' });
    expect(rendered.members['member-1']).toMatchObject({ system_disk_type: 'CLOUD_PREMIUM', system_disk_size: 50, internet_max_bandwidth_out: 0, subnet_id: 'subnet-first', tags: { RangeInstanceId: 'member-1', OwnerUserId: 'owner-1', PlatformUserId: 'owner-1', CloudAccountUid: '100000000001', CreationIntentId: 'intent-1' } });
    expect(rendered.members['member-2']).toMatchObject({ internet_max_bandwidth_out: 5, subnet_id: 'subnet-second', tags: { RangeInstanceId: 'member-2', OwnerUserId: 'owner-2' } });
    expect(JSON.stringify(rendered.members)).not.toContain('Fixture123!');
    expect(rendered.member_passwords).toEqual({ 'member-1': 'FirstFixture123!', 'member-2': 'SecondFixture123!' });
    expect(rendered.members['member-1'].client_token).toBe('intent-1');
  });

  it('preserves stable identifiers for a fifty-member plan', () => {
    const request = input();
    request.members = Array.from({ length: 50 }, (_, index) => ({ ...request.members[0], rangeInstanceId: `member-${index}`, creationIntentId: `intent-${index}`, ownerUserId: `owner-${index % 2}` }));
    const rendered = renderer.render(request);
    expect(Object.keys(rendered.members)).toHaveLength(50);
    expect(rendered.members['member-49'].tags).toMatchObject({ RangeInstanceId: 'member-49', OwnerUserId: 'owner-1', CreationIntentId: 'intent-49' });
    expect(renderer.render(request)).toEqual(rendered);
  });

  it.each([
    ['duplicated member', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[1].rangeInstanceId = request.members[0].rangeInstanceId; }],
    ['duplicated intent', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[1].creationIntentId = request.members[0].creationIntentId; }],
    ['mixed region', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.zoneId = 'ap-guangzhou-2'; }],
    ['cloud UID', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.cloudAccountUid = ''; }],
    ['missing owner', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].ownerUserId = ''; }],
    ['invalid image', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].imageId = 'aliyun-image'; }],
    ['invalid disk size', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].systemDiskSize = 19; }],
    ['fractional disk size', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].systemDiskSize = 50.5; }],
    ['weak password', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].password = 'abcdefghijk'; }],
    ['Windows hostname', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].windows = true; request.members[0].hostName = 'long-windows-hostname'; }],
    ['invalid bandwidth', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members[0].internetMaxBandwidthOut = -1; }],
    ['too many members', (request: TencentCloudSingleInstanceBatchRendererInput) => { request.members = Array.from({ length: 100 }, (_, index) => ({ ...request.members[0], rangeInstanceId: `member-${index}`, creationIntentId: `intent-${index}` })); }],
  ])('rejects %s before writing a workspace', (_, mutate) => {
    const request = input();
    mutate(request);
    expect(() => renderer.render(request)).toThrow();
  });


  it('supports the documented 60-character Linux hostname and keeps the Windows 15-character limit', () => {
    const request = input();
    request.members[0].hostName = 'a'.repeat(60);
    expect(renderer.render(request).members['member-1'].host_name).toHaveLength(60);
    request.members[0].hostName = 'a'.repeat(61);
    expect(() => renderer.render(request)).toThrow('host name');
    request.members[0].windows = true;
    request.members[0].hostName = 'a'.repeat(15);
    expect(renderer.render(request).members['member-1'].host_name).toHaveLength(15);
    request.members[0].hostName = 'a'.repeat(16);
    expect(() => renderer.render(request)).toThrow('host name');
  });

  it('uses Tencent creation password rules instead of Alibaba complexity', () => {
    const request = input();
    request.members[0].password = 'abcdefgh1';
    expect(renderer.render(request).member_passwords['member-1']).toBe('abcdefgh1');
    request.members[0].windows = true;
    expect(() => renderer.render(request)).toThrow('password');
  });

  it('supports a complete empty definition for destroying batch members', () => {
    const request = input();
    request.members = [];
    expect(renderer.render(request)).toMatchObject({ members: {}, member_passwords: {}, vpc_id: 'vpc-fixture' });
  });
});
