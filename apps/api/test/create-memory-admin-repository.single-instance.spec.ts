import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository single-instance extensions', () => {
  it('stores instanceMode, singleInstanceConfig, and default network profile fields', async () => {
    const repository = createMemoryAdminRepository();

    const single = await repository.createRangeInstance({
      name: 'web-lab-01',
      createdBy: 'admin',
      status: 'pending_create',
      instanceMode: 'single',
      expiresAt: '2026-07-10T12:00:00.000Z',
      singleInstanceConfig: {
        baseName: 'web-lab',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'web-lab-host',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04 LTS',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        remark: 'single instance',
        assignedVswitchId: 'vsw-1',
      },
    });

    await repository.upsertSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcId: 'vpc-1',
      vpcCidr: '10.200.0.0/16',
      vswitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
      vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
      securityGroupId: 'sg-1',
      securityGroupName: 'default-open-all',
    });

    const reloaded = await repository.getRangeInstanceById(single.id);
    const network = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(reloaded?.instanceMode).toBe('single');
    expect(reloaded?.singleInstanceConfig).toMatchObject({
      hostKey: 'single-ecs-1',
      platformImageAssetId: 'platform-image-1',
      cpu: 2,
      memory: 2,
    });
    expect(network).toMatchObject({
      vpcId: 'vpc-1',
      vswitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
      securityGroupId: 'sg-1',
    });
  });
});
